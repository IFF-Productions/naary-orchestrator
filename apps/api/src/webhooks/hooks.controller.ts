import {
  Body,
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { ExecutionsService } from "../executions/executions.service";
import { GraphsService } from "../graphs/graphs.service";
import { type WebhookProvider, WebhookService } from "./webhook.service";

/** Express request augmented by NestFactory({ rawBody: true }). */
interface RawReq {
  rawBody?: Buffer;
}

@Controller("hooks")
export class HooksController {
  constructor(
    private readonly webhooks: WebhookService,
    private readonly executions: ExecutionsService,
    private readonly graphs: GraphsService,
  ) {}

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
  ): Promise<{ status: string; workflowId?: string }> {
    const endpoint = await this.webhooks.getEndpoint(endpointId);
    if (!endpoint) {
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
        this.webhooks.decryptSigningSecret(endpoint), // decrypt at-rest secret
      )
    ) {
      throw new UnauthorizedException("Invalid signature");
    }

    // Dedupe AFTER verifying (don't let unsigned requests touch the store).
    const deliveryId = headers[this.webhooks.deliveryHeaderFor(provider)];
    if (
      deliveryId &&
      (await this.webhooks.isDuplicateDelivery(endpointId, deliveryId))
    ) {
      return { status: "duplicate_ignored" }; // 2xx so the provider stops retrying
    }

    // Resolve the tenant's current graph version for this endpoint's workflowKey
    // from Postgres (so a github-review endpoint reaches the reference flow, not
    // the default). Unknown/unseeded key → 404. The snapshot is version-pinned.
    const snapshot = await this.graphs.getLatest(
      endpoint.tenantId,
      endpoint.workflowId,
    );
    if (!snapshot) {
      throw new NotFoundException(
        `No graph seeded for workflowKey '${endpoint.workflowId}'`,
      );
    }

    const { workflowId } = await this.executions.startWebhook(
      endpoint.tenantId,
      snapshot,
      event,
      endpoint.workflowId, // the registry workflowKey this endpoint triggers
    );
    return { status: "started", workflowId };
  }
}
