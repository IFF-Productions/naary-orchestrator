import type { ServerResponse } from "node:http";
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Res,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
} from "@nestjs/swagger";
import type { GraphDef } from "@naary/dsl";
import {
  CurrentPrincipal,
  EnvironmentSel,
  type Principal,
  TenantId,
} from "../auth/tenant.decorator";
import { EnvironmentsService } from "../environments/environments.service";
import { SchedulesService } from "../schedules/schedules.service";
import { ApiEndpoint, ApiStandardErrors } from "../swagger/api-decorators";
import { GenerateGraphDto, PromoteGraphDto, SaveGraphDto } from "./graph.dto";
import { GraphGeneratorService } from "./graph-generator.service";
import {
  ErrorHandlerResponse,
  GenerateGraphResponse,
  GraphDetailResponse,
  GraphSummaryResponse,
  GraphVersionResponse,
  PromoteGraphResponse,
  PromotionResponse,
  SaveGraphResponse,
} from "./graph.response";
import { type GraphSummary, GraphsService } from "./graphs.service";

/** Generation ceiling for the SSE route — heartbeats keep the proxy alive, so the
 *  claude-code subprocess may run far past nginx's 60s default read timeout. */
const STREAM_GENERATE_TIMEOUT_MS = 300_000;
const STREAM_HEARTBEAT_MS = 15_000;

/** HttpException → {status, message, code?}; anything else → sanitized 500 (never
 *  leak internals into the stream — mirrors AllExceptionsFilter's intent). */
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
    message: "The model couldn't generate a workflow right now. Try again.",
  };
}

/**
 * Save a compiled graph from the canvas. tenantId comes from the token (never the
 * body). GraphsService.upsert content-hashes + versions it and runs validateGraph
 * (400 on a malformed graph) before it can be persisted or run.
 */
@ApiBearerAuth("bearer")
@Controller("graphs")
export class GraphsController {
  constructor(
    private readonly graphs: GraphsService,
    private readonly generator: GraphGeneratorService,
    private readonly schedules: SchedulesService,
    private readonly environments: EnvironmentsService,
  ) {}

  /** List the workflows in the ACTIVE environment (one row per workflowKey, latest version). */
  @ApiEndpoint({
    summary: "List workflows",
    description:
      "One row per workflowKey (its latest version), in the active environment.",
    ok: [GraphSummaryResponse],
  })
  @Get()
  async list(
    @TenantId() tenantId: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<GraphSummary[]> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.graphs.list(tenantId, envId);
  }

  /**
   * AI workflow builder: turn a plain-English description into a DRAFT graph the
   * canvas loads unsaved. Uses the tenant's own provider key (decrypted in-request,
   * never persisted) and returns a validateGraph-checked graph — the user edits and
   * saves via POST /graphs. Not saved here.
   */
  @ApiEndpoint({
    summary: "Generate a draft workflow from a description",
    description:
      "AI workflow builder — returns an unsaved draft graph; save it via POST /graphs.",
    ok: GenerateGraphResponse,
  })
  @Post("generate")
  async generate(
    @TenantId() tenantId: string,
    @Body() body: GenerateGraphDto,
    @EnvironmentSel() envSel?: string,
  ): Promise<{ name: string; graph: GraphDef }> {
    // Generate against the ACTIVE env's provider key + connections (Slice 5).
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.generator.generate(tenantId, envId, body.prompt, body.provider);
  }

  /**
   * SSE variant of POST /graphs/generate: same request/auth, but the response is a
   * text/event-stream with `: ping` heartbeats so long generations (the claude-code
   * subprocess especially) survive nginx's 60s proxy read timeout. Raw @Res (non-
   * passthrough) — Nest serialization and the global exception filter are bypassed,
   * so EVERYTHING after writeHead is caught here and written as an `error` frame.
   * NOTE: if compression middleware is ever added to the API, it must skip
   * text/event-stream or these frames buffer indefinitely.
   */
  @ApiOperation({
    summary: "Generate a draft workflow from a description (SSE)",
    description:
      "Same as POST /graphs/generate, delivered as text/event-stream with `: ping` " +
      "heartbeats. Terminal frames: `event: result` ({name, graph}) or " +
      "`event: error` ({status, message, code?}).",
  })
  @ApiProduces("text/event-stream")
  @ApiOkResponse({
    description: "SSE stream ending in a `result` or `error` frame.",
  })
  @ApiStandardErrors()
  @Post("generate/stream")
  async generateStream(
    @TenantId() tenantId: string,
    @Body() body: GenerateGraphDto,
    @Res() res: ServerResponse,
    @EnvironmentSel() envSel?: string,
  ): Promise<void> {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      // Per-response nginx directive: don't buffer this proxied response, so
      // heartbeats reach the client (and reset proxy_read_timeout) immediately.
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");

    let closed = false;
    const canWrite = () => !closed && !res.writableEnded && !res.destroyed;
    const heartbeat = setInterval(() => {
      if (canWrite()) res.write(": ping\n\n");
    }, STREAM_HEARTBEAT_MS);
    // Client gone: stop heartbeats and suppress the terminal frame. The in-flight
    // generation runs to completion and is discarded (killing the subprocess would
    // need an AbortSignal through __genDeps.exec — its own timeout bounds it).
    res.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
    });

    try {
      // Inside try (unlike the JSON route): headers are already sent, so even
      // resolveEnvId failures must become error frames, not thrown responses.
      const envId = await this.environments.resolveEnvId(tenantId, envSel);
      const result = await this.generator.generate(
        tenantId,
        envId,
        body.prompt,
        body.provider,
        { timeoutMs: STREAM_GENERATE_TIMEOUT_MS },
      );
      if (canWrite())
        res.write(`event: result\ndata: ${JSON.stringify(result)}\n\n`);
    } catch (e) {
      if (canWrite())
        res.write(`event: error\ndata: ${JSON.stringify(toErrorFrame(e))}\n\n`);
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  }

  /** Every stored version of a workflowKey (newest first) — powers the "re-run at
   *  version" picker. Identity only, no graph bodies. */
  @ApiEndpoint({
    summary: "List a workflow's versions",
    description: "Newest first; identity only (no graph bodies).",
    ok: [GraphVersionResponse],
  })
  @Get(":workflowKey/versions")
  async listVersions(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<{ version: number; contentHash: string; createdAt: string }[]> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.graphs.listVersions(tenantId, envId, workflowKey);
  }

  /** Structural diff between two versions of a workflow — review what changed before promoting. */
  @ApiEndpoint({
    summary: "Diff two versions of a workflow",
    description:
      "What changed between ?from=<v>&to=<v>: nodes added/removed/reconfigured + edges rewired.",
  })
  @Get(":workflowKey/diff")
  async diff(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @EnvironmentSel() envSel?: string,
  ) {
    // Digit-only guard: Number("") / Number("  ") coerce to 0, which would pass an integer
    // check and then wrongly 404. Require an explicit positive integer string for each.
    const isVersion = (v?: string): boolean =>
      /^[1-9][0-9]*$/.test((v ?? "").trim());
    if (!isVersion(from) || !isVersion(to)) {
      throw new BadRequestException(
        "`from` and `to` must be positive integer version numbers.",
      );
    }
    const fromV = Number(from);
    const toV = Number(to);
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.graphs.diffVersions(tenantId, envId, workflowKey, fromV, toV);
  }

  /** The latest graph for a workflowKey — used to open it in the canvas. */
  @ApiEndpoint({
    summary: "Get a workflow's latest graph",
    ok: GraphDetailResponse,
    notFound: true,
  })
  @Get(":workflowKey")
  async get(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<{
    workflowKey: string;
    name: string;
    version: number;
    graph: GraphDef;
  }> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    const found = await this.graphs.getLatestNamed(
      tenantId,
      envId,
      workflowKey,
    );
    if (!found) {
      throw new NotFoundException(`No graph for workflowKey '${workflowKey}'`);
    }
    return found;
  }

  /** The workflowKey of this workflow's error handler (null if none). */
  @ApiEndpoint({
    summary: "Get a workflow's error handler",
    ok: ErrorHandlerResponse,
  })
  @Get(":workflowKey/error-handler")
  async getErrorHandler(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
  ): Promise<{ errorWorkflowKey: string | null }> {
    return {
      errorWorkflowKey: await this.graphs.getErrorHandler(
        tenantId,
        workflowKey,
      ),
    };
  }

  /** Bind (or clear, with null/empty) this workflow's error handler. */
  @ApiEndpoint({
    summary: "Bind or clear a workflow's error handler",
    ok: ErrorHandlerResponse,
  })
  @Put(":workflowKey/error-handler")
  async setErrorHandler(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @Body() body: { errorWorkflowKey?: string | null },
  ): Promise<{ errorWorkflowKey: string | null }> {
    const value = body.errorWorkflowKey?.trim() || null;
    if (value === workflowKey) {
      throw new BadRequestException(
        "A workflow cannot be its own error handler",
      );
    }
    await this.graphs.setErrorHandler(tenantId, workflowKey, value);
    return { errorWorkflowKey: value };
  }

  @ApiEndpoint({
    summary: "Save (version) a workflow graph",
    description:
      "Content-hashes + versions the graph; re-syncs poll/cron schedules for trigger graphs.",
    created: SaveGraphResponse,
  })
  @Post()
  async save(
    @TenantId() tenantId: string,
    @Body() body: SaveGraphDto,
    @EnvironmentSel() envSel?: string,
  ): Promise<{ workflowKey: string; version: number; contentHash: string }> {
    const graph = toGraphDef(body.graph);
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    const snap = await this.graphs.upsert(
      tenantId,
      envId,
      body.workflowKey,
      body.name,
      graph,
    );
    // Temporal schedules aren't env-scoped yet (deferred), so ONLY (re)sync them when saving in
    // the DEFAULT env — else a non-default (sandbox) save would reconfigure the default/prod env's
    // cron/interval from the sandbox graph. Best-effort — a scheduling hiccup must not fail a save.
    if (await this.environments.isDefaultEnv(tenantId, envId)) {
      await this.schedules
        .syncPollSchedule(tenantId, body.workflowKey, graph)
        .catch(() => undefined);
      await this.schedules
        .syncCronSchedule(tenantId, body.workflowKey, graph)
        .catch(() => undefined);
    }
    return {
      workflowKey: body.workflowKey,
      version: snap.version,
      contentHash: snap.contentHash,
    };
  }

  /** Promote a workflow's definition from the ACTIVE env (X-Environment-Id) into a target env
   *  (copy-on-promote). Creds/connections are NOT copied — the target binds to its own. */
  @ApiEndpoint({
    summary: "Promote a workflow to another environment",
    description:
      "Copies the active env's graph (a chosen version, default latest) into the target env as a new version, and records lineage. Credentials/connections are not copied.",
    created: PromoteGraphResponse,
    notFound: true,
  })
  @Post(":workflowKey/promote")
  async promote(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @Body() body: PromoteGraphDto,
    @CurrentPrincipal() principal: Principal,
    @EnvironmentSel() envSel?: string,
  ): Promise<{ fromVersion: number; toVersion: number; contentHash: string }> {
    const fromEnvId = await this.environments.resolveEnvId(tenantId, envSel);
    const toEnvId = await this.environments.resolveEnvId(tenantId, body.toEnv);
    const actor = principal.subject ?? principal.userId ?? "api-token";
    return this.graphs.promote(
      tenantId,
      workflowKey,
      fromEnvId,
      toEnvId,
      actor,
      body.fromVersion,
    );
  }

  /** A workflow's promotion history (lineage/audit) — newest first. */
  @ApiEndpoint({
    summary: "List a workflow's promotions",
    description:
      "Who promoted this workflow between envs, when, and the source→target versions.",
    ok: [PromotionResponse],
  })
  @Get(":workflowKey/promotions")
  promotions(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
  ): Promise<PromotionResponse[]> {
    return this.graphs.listPromotions(tenantId, workflowKey);
  }

  /** Delete a workflow and everything bound to it (graph versions, activation, pins, error-handler
   *  bindings, and its webhook/form/chat triggers + Temporal schedules). 404 if the key is unknown. */
  @ApiEndpoint({
    summary: "Delete a workflow",
    description:
      "Removes the graph (all versions) and its triggers/schedules. Execution history is kept.",
    notFound: true,
  })
  @Delete(":workflowKey")
  async remove(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<{ deleted: true }> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    const isDefault = await this.environments.isDefaultEnv(tenantId, envId);
    // Schedules + the shared (not-yet-env-scoped) rows/triggers only belong to the default env's
    // copy — tearing them down from a NON-default env would kill the default/prod copy's schedules
    // and webhooks for the same workflowKey. So only do the tenant-wide teardown in the default env.
    if (isDefault) {
      await this.schedules
        .teardownForWorkflow(tenantId, workflowKey)
        .catch(() => undefined);
    }
    const deleted = await this.graphs.deleteWorkflow(
      tenantId,
      envId,
      workflowKey,
      isDefault,
    );
    if (!deleted) {
      throw new NotFoundException(`No workflow '${workflowKey}'`);
    }
    return { deleted: true };
  }
}

/** Guard the top-level shape so a non-graph body is a 400, not a 500 inside
 *  validateGraph (which assumes nodes/edges arrays). Deep rules are validateGraph's. */
function toGraphDef(g: Record<string, unknown>): GraphDef {
  if (
    !Array.isArray(g.nodes) ||
    !Array.isArray(g.edges) ||
    typeof g.startNodeId !== "string"
  ) {
    throw new BadRequestException(
      "graph must have { nodes: [], edges: [], startNodeId: string }",
    );
  }
  return g as unknown as GraphDef;
}
