import type { ServerResponse } from "node:http";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  Res,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
} from "@nestjs/swagger";
import { getBudget } from "@naary/usage";
import {
  CurrentPrincipal,
  EnvironmentSel,
  type Principal,
  TenantId,
} from "../auth/tenant.decorator";
import { assertWithinMonthlyBudget } from "../budget/budget-guard";
import { EnvironmentsService } from "../environments/environments.service";
import { GraphGeneratorService } from "../graphs/graph-generator.service";
import { ApiEndpoint, ApiStandardErrors } from "../swagger/api-decorators";
import {
  BuilderSessionResponse,
  BuilderSessionSummaryResponse,
} from "./builder-session.response";
import { BuilderSessionsService } from "./builder-sessions.service";
import { CloseSessionDto, OpenSessionDto, SendTurnDto } from "./builder.dto";
import { turnPrevious } from "./turn-input";
import {
  deriveTitle,
  estimateTurnCostUsd,
  suggestNextOptions,
  summarizeChange,
} from "./turn-metering";

/** Turn generation ceiling — heartbeats keep the proxy alive past its read timeout (same as
 *  the /graphs/generate/stream route). */
const TURN_TIMEOUT_MS = 300_000;
const TURN_HEARTBEAT_MS = 15_000;

/** HttpException → {status, message, code?}; anything else → a sanitized 500 (never leak
 *  internals into the stream — mirrors AllExceptionsFilter + the /graphs SSE route). */
function toErrorFrame(e: unknown): {
  status: number;
  message: string;
  code?: string;
} {
  if (e instanceof HttpException) {
    const resp = e.getResponse();
    if (typeof resp === "string")
      return { status: e.getStatus(), message: resp };
    const body = resp as { message?: string | string[]; code?: string };
    const message = Array.isArray(body.message)
      ? body.message.join("; ")
      : (body.message ?? e.message);
    return {
      status: e.getStatus(),
      message,
      ...(body.code ? { code: body.code } : {}),
    };
  }
  return {
    status: 500,
    message: "The model couldn't apply that change right now. Try again.",
  };
}

/**
 * Conversational AI builder — session lifecycle + edit turns (Slices 1–2). Open a session to
 * iteratively build a workflow via chat, send turns that stream the edited graph onto the canvas,
 * resume it later, and close it on save or when done.
 *
 * Scoping: every route is workspace(tenant)-scoped. `open` and the resume list (`GET /`) are
 * additionally scoped to the ACTIVE environment (a build targets one env). `GET /:id`, `close`,
 * and `:id/turns` address a specific session by its unique id — the session carries its own
 * `environmentId`, so they resolve env-agnostically (you can resume a build regardless of the
 * env header you happen to send).
 */
@ApiBearerAuth("bearer")
@ApiStandardErrors({ notFound: true })
@Controller("builder/sessions")
export class BuilderSessionsController {
  constructor(
    private readonly sessions: BuilderSessionsService,
    private readonly environments: EnvironmentsService,
    private readonly generator: GraphGeneratorService,
  ) {}

  @ApiEndpoint({
    summary: "Open a builder session",
    created: BuilderSessionResponse,
  })
  @Post()
  async open(
    @TenantId() tenantId: string,
    @Body() body: OpenSessionDto,
    @EnvironmentSel() envSel?: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<BuilderSessionResponse> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    // The principal is threaded so seeding from `workflowKey` honours the per-workflow view
    // grant — see the note in BuilderSessionsService.open.
    return this.sessions.open(
      tenantId,
      envId,
      { workflowKey: body?.workflowKey, title: body?.title },
      principal,
    );
  }

  @ApiEndpoint({
    summary: "List open builder sessions (resume list, active environment)",
    ok: [BuilderSessionSummaryResponse],
  })
  @Get()
  async listOpen(
    @TenantId() tenantId: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<BuilderSessionSummaryResponse[]> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.sessions.listOpen(tenantId, envId);
  }

  @ApiEndpoint({
    summary: "Get / resume a builder session",
    ok: BuilderSessionResponse,
  })
  @Get(":id")
  async get(
    @TenantId() tenantId: string,
    @Param("id") id: string,
  ): Promise<BuilderSessionResponse> {
    return this.sessions.get(tenantId, id);
  }

  /**
   * Send a conversation turn: apply the message as an edit to the session's working draft and
   * STREAM the result (SSE, reusing the /graphs/generate/stream frame protocol — `meta`/`node`/
   * `edge`, then a terminal `result` or `error`). On success the user + a short assistant
   * change-summary are appended and `currentGraph` is rewritten (one transaction); the turn's
   * BYOK cost is metered onto the assistant turn. The FIRST turn on a blank session is a create.
   *
   * Preconditions (404 not-owner / 409 closed / 402 over-budget) are checked BEFORE the stream
   * opens, so they surface as real HTTP statuses — not error frames the client must parse.
   */
  @ApiOperation({
    summary: "Send an edit turn (SSE)",
    description:
      "Applies the message to the working draft and streams the edited graph as text/event-stream: " +
      "`event: meta` ({name}), then `event: node`/`event: edge` as each completes, ending in " +
      "`event: result` ({name, graph}) or `event: error` ({status, message, code?}). 409 if the " +
      "session is closed; 402 if the workspace is over its monthly budget.",
  })
  @ApiProduces("text/event-stream")
  @ApiStandardErrors({ notFound: true, conflict: true })
  @ApiOkResponse({
    description: "SSE stream ending in a `result` or `error` frame.",
  })
  @Post(":id/turns")
  async turn(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @Body() body: SendTurnDto,
    @Res() res: ServerResponse,
    @EnvironmentSel() envSel?: string,
  ): Promise<void> {
    // --- Preconditions BEFORE writeHead — thrown here → real 400/404/409/402 responses. ---
    const message = body?.message?.trim();
    if (!message) throw new BadRequestException("A message is required.");
    const session = await this.sessions.getForTurn(tenantId, id); // 404 if not this workspace's
    if (session.status === "closed") {
      throw new ConflictException(
        "This builder session is closed — start a new one to keep editing.",
      );
    }
    // Every turn passes the existing monthly budget gate (design §5). NOTE: builder BYOK spend is
    // metered onto the turn but NOT ledgered as run usage, so it doesn't itself count toward the
    // cap — this gate reflects run spend only (same as POST /graphs/generate).
    const budget = await getBudget(tenantId);
    await assertWithinMonthlyBudget(tenantId, budget); // 402 when at/over the cap
    // Build in the env the session targets (falls back to the request's active env).
    const envId =
      session.environmentId ??
      (await this.environments.resolveEnvId(tenantId, envSel));

    // --- Stream (headers sent; from here every failure is an `error` frame). ---
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");

    let closed = false;
    const canWrite = () => !closed && !res.writableEnded && !res.destroyed;
    const heartbeat = setInterval(() => {
      if (canWrite()) res.write(": ping\n\n");
    }, TURN_HEARTBEAT_MS);
    res.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
    });

    try {
      const result = await this.generator.editStream(
        tenantId,
        envId,
        // The caller's own draft when it sent one (the canvas panel owns its graph, unsaved edits
        // included), otherwise the session's. No prior draft either way ⇒ this turn is a create.
        // See turn-input.ts for why the asymmetry is deliberate.
        {
          previous: turnPrevious(body.graph, session.currentGraph),
          instruction: message,
        },
        body.provider,
        {
          timeoutMs: TURN_TIMEOUT_MS,
          onMeta: (name) => {
            if (canWrite())
              res.write(`event: meta\ndata: ${JSON.stringify({ name })}\n\n`);
          },
          onNode: (node) => {
            if (canWrite())
              res.write(`event: node\ndata: ${JSON.stringify(node)}\n\n`);
          },
          onEdge: (edge) => {
            if (canWrite())
              res.write(`event: edge\ndata: ${JSON.stringify(edge)}\n\n`);
          },
        },
      );
      // Meter the turn (Tier-1 §6 — an estimate when the provider reported no usage) and persist
      // the whole turn atomically. Persist even if the client disconnected mid-stream: the work
      // is done, so the draft + conversation must survive for the resume path.
      const costUsd = estimateTurnCostUsd(result.meter, result.graph);
      await this.sessions.applyTurn(tenantId, id, {
        userMessage: message,
        graph: result.graph,
        assistantSummary: summarizeChange(result.name, result.graph),
        options: suggestNextOptions(result.graph),
        costUsd,
        titleIfUnset: session.title ? undefined : deriveTitle(message),
      });
      if (canWrite())
        res.write(
          `event: result\ndata: ${JSON.stringify({ name: result.name, graph: result.graph })}\n\n`,
        );
    } catch (e) {
      if (canWrite())
        res.write(`event: error\ndata: ${JSON.stringify(toErrorFrame(e))}\n\n`);
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  }

  @ApiEndpoint({
    summary: "Close a builder session",
    ok: BuilderSessionResponse,
  })
  @Post(":id/close")
  @HttpCode(200)
  async close(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @Body() body: CloseSessionDto,
  ): Promise<BuilderSessionResponse> {
    return this.sessions.close(tenantId, id, body.reason);
  }
}
