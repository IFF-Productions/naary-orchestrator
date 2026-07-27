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
// Deep import on purpose (mirrors graphs.service.ts's `@naary/dsl/dist/registry`): the n8n importer
// is kept OUT of the @naary/dsl barrel so it can't reach the worker's deterministic bundle.
import {
  type N8nImportResult,
  parseN8nWorkflow,
} from "@naary/dsl/dist/n8n-import";
import {
  CurrentPrincipal,
  EnvironmentSel,
  type Principal,
  TenantId,
} from "../auth/tenant.decorator";
import { EnvironmentsService } from "../environments/environments.service";
import { ApiEndpoint, ApiStandardErrors } from "../swagger/api-decorators";
import {
  GenerateGraphDto,
  ImportN8nDto,
  PromoteGraphDto,
  SaveGraphDto,
} from "./graph.dto";
import { GraphGeneratorService } from "./graph-generator.service";
import { type DryRunResult, DryRunService } from "./dry-run.service";
import {
  DryRunResponse,
  ErrorHandlerResponse,
  GenerateGraphResponse,
  GraphDetailResponse,
  ImportN8nResponse,
  GraphSummaryResponse,
  GraphVersionResponse,
  PromoteGraphResponse,
  PromotionResponse,
  SaveGraphResponse,
} from "./graph.response";
import { type GraphSummary, GraphsService } from "./graphs.service";
import { WorkflowLifecycleService } from "./workflow-lifecycle.service";

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
    private readonly lifecycle: WorkflowLifecycleService,
    private readonly environments: EnvironmentsService,
    private readonly dry: DryRunService,
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
    @CurrentPrincipal() principal?: Principal,
  ): Promise<GraphSummary[]> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.graphs.list(tenantId, envId, principal);
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
   * Import an n8n workflow export into a DRAFT graph + an honest mapping report (#579).
   *
   * Same shape as `POST /graphs/generate`: nothing is persisted. The canvas loads the draft, the
   * user reads the report, reconnects credentials, and saves via `POST /graphs` — which is where
   * the save gates and versioning happen (there is no draft state in the schema).
   *
   * Pure and tenant-agnostic: the translation reads only the posted JSON, so no env resolution and
   * no provider key are involved. **Credentials in the export are never imported** — the response
   * reports which connection types to create.
   */
  @ApiEndpoint({
    summary: "Import an n8n workflow export as a draft",
    description:
      "Translates an n8n workflow JSON into an unsaved draft graph plus a per-node mapping report " +
      "(imported / approximated / unmapped-with-placeholder / skipped). Credentials are never " +
      "imported. Save the draft via POST /graphs.",
    ok: ImportN8nResponse,
  })
  @Post("import/n8n")
  importN8n(@Body() body: ImportN8nDto): N8nImportResult {
    try {
      return parseN8nWorkflow(body.workflow);
    } catch (e) {
      // The importer throws only when the payload isn't an n8n workflow at all; everything else
      // degrades into a placeholder + a report entry. That distinction is the 400 boundary.
      throw new BadRequestException(
        e instanceof Error ? e.message : "Could not read the n8n workflow.",
      );
    }
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
      "heartbeats. For the API-model providers the graph streams live: `event: meta` " +
      "({name}) once known, then `event: node` (a node) + `event: edge` (an edge) as each " +
      "completes. Terminal frames: `event: result` ({name, graph} — the authoritative " +
      "validated graph) or `event: error` ({status, message, code?}). Clients that only " +
      "handle result/error stay compatible (node/edge/meta are ignored).",
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
      // Live frames as the model streams (API-model path): `meta` (name), then a `node`
      // per node and an `edge` per edge as each completes. Old clients that only handle
      // `result`/`error` ignore these. The claude-code path emits none — just the result.
      const result = await this.generator.generateStream(
        tenantId,
        envId,
        body.prompt,
        body.provider,
        {
          timeoutMs: STREAM_GENERATE_TIMEOUT_MS,
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
      // Authoritative terminal frame — the client reconciles its live canvas to this.
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
    @CurrentPrincipal() principal?: Principal,
  ): Promise<{ version: number; contentHash: string; createdAt: string }[]> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.graphs.listVersions(tenantId, envId, workflowKey, principal);
  }

  /**
   * DRY RUN (#832) — "will this flow run?", answered without executing anything.
   *
   * Three layers: pure catalog validation, a pure request build, and — the only network call — the
   * SAME non-destructive credential probe the Integrations "Test" button uses, which the catalog
   * restricts to `write: false` actions. No node is executed, so this is safe to press on a flow
   * with real side effects. Each connection is probed once even when several nodes share it.
   *
   * Authorized as a READ of the graph (`getLatestNamed` asserts `view`): a dry run starts nothing
   * and changes nothing. It does spend one provider call per distinct connection, which is why the
   * probe is capped at one per connection and why it lives behind an explicit button rather than
   * running continuously.
   */
  @ApiEndpoint({
    summary: "Dry-run a workflow (no execution)",
    description:
      "Validates every integration node's config and request shape, and probes each connection " +
      "with the provider's cheapest READ-ONLY action. Executes nothing.",
    ok: DryRunResponse,
    notFound: true,
  })
  @Post(":workflowKey/dry-run")
  async dryRun(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @EnvironmentSel() envSel?: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<DryRunResult> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    // Authorization rides on the graph read — `getLatestNamed` asserts `view` for the actor, the
    // same gate every other read on this controller uses. (A dry run reads and probes; it starts
    // nothing.)
    const found = await this.graphs.getLatestNamed(
      tenantId,
      envId,
      workflowKey,
      principal,
    );
    if (!found) {
      throw new NotFoundException(`No graph saved for '${workflowKey}'`);
    }
    return this.dry.check(tenantId, found.graph);
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
    @CurrentPrincipal() principal?: Principal,
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
    return this.graphs.diffVersions(
      tenantId,
      envId,
      workflowKey,
      fromV,
      toV,
      principal,
    );
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
    @CurrentPrincipal() principal?: Principal,
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
      principal,
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
    @EnvironmentSel() envSel?: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<{ errorWorkflowKey: string | null }> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return {
      errorWorkflowKey: await this.graphs.getErrorHandler(
        tenantId,
        envId,
        workflowKey,
        principal,
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
    @EnvironmentSel() envSel?: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<{ errorWorkflowKey: string | null }> {
    const value = body.errorWorkflowKey?.trim() || null;
    if (value === workflowKey) {
      throw new BadRequestException(
        "A workflow cannot be its own error handler",
      );
    }
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    await this.graphs.setErrorHandler(
      tenantId,
      envId,
      workflowKey,
      value,
      principal,
    );
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
    @CurrentPrincipal() principal?: Principal,
  ): Promise<{ workflowKey: string; version: number; contentHash: string }> {
    const graph = toGraphDef(body.graph);
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    // Consolidated save path (shared with v1): upsert + the env-scoped, best-effort
    // poll/cron schedule sync live in WorkflowLifecycleService. The principal gates the
    // save (§4): existing key ⇒ edit, new key ⇒ canCreate.
    const snap = await this.lifecycle.saveWorkflow(
      tenantId,
      envId,
      body.workflowKey,
      body.name,
      graph,
      principal,
      body.message,
    );
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
    // share = promote (§8.2); the grant must match the SOURCE env — asserted in-service.
    return this.graphs.promote(
      tenantId,
      workflowKey,
      fromEnvId,
      toEnvId,
      actor,
      body.fromVersion,
      principal,
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
  async promotions(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @EnvironmentSel() envSel?: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<PromotionResponse[]> {
    // View-gated (§4) against the caller's ACTIVE env — resolved here like every other route.
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.graphs.listPromotions(tenantId, workflowKey, principal, envId);
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
    @CurrentPrincipal() principal?: Principal,
  ): Promise<{ deleted: true }> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    // Consolidated delete path (shared with v1): the env-scoped, best-effort schedule
    // teardown lives in WorkflowLifecycleService. The principal gates
    // the delete (§4) before any teardown side effect.
    const deleted = await this.lifecycle.deleteWorkflow(
      tenantId,
      envId,
      workflowKey,
      principal,
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
