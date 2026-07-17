import {
  Body,
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import { createLogger } from "@naary/logging";
import { Public } from "../auth/public.decorator";
import { verifyResumeToken } from "../executions/resume-token";
import { ExecutionsService } from "../executions/executions.service";
import { GraphsService } from "../graphs/graphs.service";
import { type WebhookProvider, WebhookService } from "./webhook.service";

/** Minimal Express response surface we use (avoids a direct @types/express dep). */
interface Res {
  status(code: number): unknown;
  set(headers: Record<string, string>): unknown;
}

/** Express request augmented by NestFactory({ rawBody: true }). */
interface RawReq {
  rawBody?: Buffer;
}

/** Structured logger for the webhook ingress. Scrubs secrets; never logs the body/headers. */
const log = createLogger({ component: "api" });

@Controller("hooks")
export class HooksController {
  constructor(
    private readonly webhooks: WebhookService,
    private readonly executions: ExecutionsService,
    private readonly graphs: GraphsService,
  ) {}

  /**
   * Resume ingress: an external system POSTs here to continue a run paused on a wait(webhook)
   * node. Authenticated by the HMAC `token` over the workflowId (the URL is the credential — no
   * bearer). The POST body becomes the node's `payload`. 202 on success; 409 if the run isn't
   * paused. Declared BEFORE `:endpointId` for clarity (it's a distinct 2-segment path).
   */
  @Public()
  @Post("resume/:workflowId")
  @HttpCode(202)
  async resume(
    @Param("workflowId") workflowId: string,
    @Query("token") token: string,
    @Body() payload: unknown,
  ): Promise<{ status: string }> {
    if (!verifyResumeToken(workflowId, token)) {
      throw new UnauthorizedException("Invalid or missing resume token");
    }
    await this.executions.resumeByToken(workflowId, payload ?? null);
    return { status: "resumed" };
  }

  /**
   * Webhook ingress: verify signature over the RAW body → dedupe on delivery id →
   * start the workflow with the event as the trigger node's output.
   */
  @Public() // authenticated by HMAC signature over the raw body, not a bearer token
  @Post(":endpointId")
  @HttpCode(202)
  async ingress(
    @Param("endpointId") endpointId: string,
    @Req() req: RawReq,
    @Body() event: unknown,
    @Headers() headers: Record<string, string>,
    @Res({ passthrough: true }) res: Res,
  ): Promise<unknown> {
    // One structured line per ingress with LATENCY (durationMs) — makes a slow/timing-out
    // webhook visible without guessing. Never logs the body/headers/secret (ids only).
    const startedAt = Date.now();
    const ms = () => Date.now() - startedAt;

    // Audit S-4: reject unsigned requests BEFORE the DB read + AES-decrypt, so a
    // caller who only knows an endpoint id can't force per-request DB/crypto work.
    // The signature header is the same for every provider (X-Hub-Signature-256).
    if (!headers["x-hub-signature-256"]) {
      log.warn(
        { endpointId, durationMs: ms() },
        "webhook rejected: no signature",
      );
      throw new UnauthorizedException("Missing signature");
    }

    const endpoint = await this.webhooks.getEndpoint(endpointId);
    if (!endpoint) {
      log.warn(
        { endpointId, durationMs: ms() },
        "webhook rejected: unknown endpoint",
      );
      throw new NotFoundException("Unknown webhook endpoint");
    }
    const provider = endpoint.provider as WebhookProvider;

    // HMAC over the exact received bytes (never the re-serialized JSON).
    const rawBody = req.rawBody ?? Buffer.alloc(0);
    const signature = headers["x-hub-signature-256"];
    if (
      !this.webhooks.verifySignature(
        provider,
        rawBody,
        signature,
        await this.webhooks.decryptSigningSecret(endpoint), // decrypt at-rest secret
      )
    ) {
      log.warn(
        { endpointId, provider, tenantId: endpoint.tenantId, durationMs: ms() },
        "webhook rejected: invalid signature",
      );
      throw new UnauthorizedException("Invalid signature");
    }

    // Resolve the graph BEFORE recording the delivery for dedupe. Order matters:
    // recording a delivery is a COMMIT to processing it — the @@unique row suppresses
    // every future retry of the same id for the whole retention window. Unknown/unseeded
    // key → 404 (config not finished); doing this first means a not-yet-seeded endpoint
    // doesn't burn the delivery so the provider's retry works once the graph exists.
    // The snapshot is version-pinned (so a github-review endpoint reaches the reference
    // flow, not the default).
    // Public trigger fires in the endpoint's OWN environment (design §Slice 4).
    const snapshot = await this.graphs.getLatest(
      endpoint.tenantId,
      endpoint.environmentId,
      endpoint.workflowId,
    );
    if (!snapshot) {
      log.warn(
        {
          endpointId,
          provider,
          tenantId: endpoint.tenantId,
          workflowKey: endpoint.workflowId,
          durationMs: ms(),
        },
        "webhook rejected: no graph for workflowKey",
      );
      throw new NotFoundException(
        `No graph seeded for workflowKey '${endpoint.workflowId}'`,
      );
    }

    // Dedupe AFTER verifying + confirming there's a graph to run. Recording BEFORE the
    // start still wins the race against a concurrent duplicate (the @@unique constraint),
    // but we roll it back if the start throws (below) so a transient failure — an INACTIVE
    // workflow, Temporal down — doesn't permanently swallow the delivery as a duplicate.
    const deliveryId = headers[this.webhooks.deliveryHeaderFor(provider)];
    let recorded = false;
    if (deliveryId) {
      if (await this.webhooks.isDuplicateDelivery(endpointId, deliveryId)) {
        log.info(
          { endpointId, provider, deliveryId, durationMs: ms() },
          "webhook duplicate ignored",
        );
        return { status: "duplicate_ignored" }; // 2xx so the provider stops retrying
      }
      recorded = true;
    }

    const base = {
      endpointId,
      provider,
      deliveryId,
      tenantId: endpoint.tenantId,
      workflowKey: endpoint.workflowId,
    };

    // From here we START the run. If it throws, roll back the dedupe record so the
    // provider's retry isn't swallowed as a duplicate — the id is only "spent" once a
    // run actually starts. (The run id is random per start, so the sole residual risk
    // is a start that succeeds server-side but whose ack is lost → a retry double-runs;
    // inherent to at-least-once delivery, and far rarer than the burn this replaces.)
    try {
      // If the graph has a respondToWebhook node, wait (bounded) for its response and
      // return it synchronously; otherwise stay fire-and-forget (202, unchanged).
      const wantsResponse = snapshot.graph.nodes.some(
        (n) => n.type === "respondToWebhook",
      );
      if (wantsResponse) {
        const { workflowId, response } =
          await this.executions.startWebhookAwaitResponse(
            endpoint.tenantId,
            endpoint.environmentId,
            snapshot,
            event,
            endpoint.workflowId,
          );
        log.info(
          {
            ...base,
            workflowId,
            mode: "sync",
            responded: !!response,
            durationMs: ms(),
          },
          "webhook started (await-response)",
        );
        if (response) {
          res.status(response.statusCode);
          if (response.headers) res.set(response.headers);
          return response.body ?? null;
        }
        // Ran but didn't respond in time (e.g. it paused first) — fall back to 202.
        return { status: "started", workflowId };
      }

      const { workflowId } = await this.executions.startWebhook(
        endpoint.tenantId,
        endpoint.environmentId,
        snapshot,
        event,
        endpoint.workflowId, // the registry workflowKey this endpoint triggers
      );
      log.info(
        { ...base, workflowId, mode: "async", durationMs: ms() },
        "webhook started",
      );
      return { status: "started", workflowId };
    } catch (err) {
      // The run didn't start — un-burn the delivery so a retry can try again.
      if (recorded && deliveryId) {
        await this.webhooks.removeDelivery(endpointId, deliveryId);
      }
      throw err;
    }
  }
}
