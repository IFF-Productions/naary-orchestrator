import type { ServerResponse } from "node:http";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { ApiBearerAuth, ApiProduces, ApiQuery } from "@nestjs/swagger";
import {
  CurrentPrincipal,
  EnvironmentSel,
  type Principal,
  TenantId,
} from "../auth/tenant.decorator";
import { EnvironmentsService } from "../environments/environments.service";
import { ApiEndpoint } from "../swagger/api-decorators";
import {
  ApproveBatchDto,
  ApproveDto,
  ArchiveBatchDto,
  CancelBatchDto,
  RerunDto,
  ResumeRunDto,
  StartExecutionDto,
} from "./execution.dto";
import { NotificationsService } from "../notifications/notifications.service";
import {
  AcceptedResponse,
  AwaitingApprovalResponse,
  BatchDecisionItemResponse,
  RemindResponse,
  ResumeUrlResponse,
  RunEventResponse,
  RunGraphResponse,
  RunListItemResponse,
  RunPageResponse,
  RunStateResponse,
  ResumeEligibilityResponse,
  StartExecutionResponse,
} from "./execution.response";
import {
  type AwaitingApproval,
  type BatchDecisionResult,
  ExecutionsService,
  type RunEvent,
  type RunStateView,
} from "./executions.service";

@ApiBearerAuth("bearer")
@Controller("executions")
export class ExecutionsController {
  constructor(
    private readonly executions: ExecutionsService,
    private readonly environments: EnvironmentsService,
    private readonly notifications: NotificationsService,
  ) {}

  @ApiEndpoint({
    summary: "Start a run",
    description: "Starts a run of the given workflow (defaults to 'default').",
    created: StartExecutionResponse,
  })
  @Post()
  async start(
    @TenantId() tenantId: string,
    @Body() body: StartExecutionDto,
    @EnvironmentSel() envSel?: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<{ workflowId: string }> {
    // Manual run → the ACTIVE environment (from X-Environment-Id). The principal gates
    // the start with `run` (RBAC-GROUPS.md §4) — trigger paths never come through here.
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.executions.start(
      tenantId,
      envId,
      body.input,
      body.workflowKey,
      undefined,
      principal,
      body.debug ?? false,
    );
  }

  /** Run a minimal read-only codeAgent (Claude Code) run to verify the CLI + BYOK key work
   *  end-to-end. Returns the run id; poll GET /executions/:id for the outcome. */
  @ApiEndpoint({
    summary: "Test the Code Agent (Claude Code) connectivity",
    description:
      "Starts a minimal read-only codeAgent run (asks the CLI to reply OK). Poll the returned run for success/failure.",
    created: StartExecutionResponse,
  })
  @Post("code-agent-test")
  async codeAgentTest(
    @TenantId() tenantId: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<{ workflowId: string }> {
    // Test against the ACTIVE env's Claude Code key (Slice 5b).
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.executions.startCodeAgentTest(tenantId, envId);
  }

  /** Recent runs for the authenticated tenant (newest first). `?archived=true`
   *  returns the soft-archived runs instead of the active (default) list. `?q=` searches
   *  runs by contained data (trigger input) plus their id/workflowKey (#463). */
  @ApiEndpoint({
    summary: "List recent runs",
    description:
      "Recent runs for the tenant (newest first). `archived=true` shows the archived runs instead. " +
      "`q` searches runs by the data they contain (the run's trigger input) as well as their id/workflow.",
    ok: [RunListItemResponse],
  })
  // OPTIONAL: without this the Nest plugin marks `archived` required+string in the spec, forcing every
  // generated client to send it. It's optional — omit for the default (active) list.
  @ApiQuery({ name: "archived", required: false, type: Boolean })
  @ApiQuery({
    name: "q",
    required: false,
    type: String,
    description:
      "Free-text substring search over the run's contained data (trigger input) + id/workflow.",
  })
  @Get()
  listRuns(
    @TenantId() tenantId: string,
    @Query("archived") archived?: string,
    @Query("q") q?: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<RunListItemResponse[]> {
    // G3 (§8.4): a restricted member/token sees only runs of workflows it may view.
    return this.executions.list(
      tenantId,
      50,
      archived === "true",
      principal,
      q,
    );
  }

  /**
   * Cursor-paged runs — what the Runs screen lists, so a tenant can reach past the newest page
   * instead of being capped at the most recent 50.
   *
   * WHY A SIBLING ROUTE and not `limit`/`cursor` on `GET /executions`: nine other SPA surfaces
   * (Overview, Workflows, charts, Billing, the notifications bell, …) call that endpoint purely for
   * "recent runs" and want the plain array. Paginating in place would either change the response
   * shape for all of them or make it polymorphic on a query param — an envelope-or-array union is
   * miserable to type and generate clients from. Additive route, one caller, zero blast radius.
   * Must be declared BEFORE `@Get(":id")` so "page" isn't captured as an :id (same as "awaiting").
   *
   * NOTE the status tabs are deliberately NOT a server-side filter here — see the Runs screen. A
   * non-terminal row's status is reconciled against Temporal AFTER the query (a stored `running`
   * whose workflow threw reports `failed`), so a SQL `status IN (…)` would return confidently wrong
   * pages.
   */
  @ApiEndpoint({
    summary: "List runs (cursor-paged)",
    description:
      "Runs for the tenant (newest first), keyset-paged on (createdAt, workflowId). Pass the " +
      "previous page's `nextCursor` as `?cursor=` for the next page; `nextCursor` is null on the " +
      "last page. `archived` and `q` behave as on GET /executions and compose with paging.",
    ok: RunPageResponse,
  })
  @ApiQuery({ name: "archived", required: false, type: Boolean })
  @ApiQuery({ name: "q", required: false, type: String })
  @ApiQuery({
    name: "cursor",
    required: false,
    type: String,
    description: "The previous page's `nextCursor`. Omit for the first page.",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    description: "Page size, 1–100 (default 50). Clamped, never rejected.",
  })
  @Get("page")
  async listRunsPage(
    @TenantId() tenantId: string,
    @Query("archived") archived?: string,
    @Query("q") q?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<RunPageResponse> {
    // Clamped in queryListPage (1–100); a non-numeric `limit` parses to NaN, so fall back to the
    // default rather than letting NaN reach `take` and blow up the query.
    const parsed = Number(limit);
    const page = await this.executions.listPage(
      tenantId,
      {
        ...(Number.isFinite(parsed) && parsed > 0 ? { limit: parsed } : {}),
        ...(cursor ? { cursor } : {}),
        archived: archived === "true",
        ...(q ? { q } : {}),
      },
      // G3 (§8.4): a restricted member/token sees only runs of workflows it may view. The view
      // filter is applied IN the where clause, so pagination stays exact under restriction.
      principal,
    );
    return { items: page.items, nextCursor: page.nextCursor };
  }

  /** The tenant's runs paused for approval, each with its prompt (the inbox). Must
   *  be declared BEFORE `@Get(":id")` so "awaiting" isn't captured as an :id. */
  @ApiEndpoint({
    summary: "List runs awaiting approval",
    description: "The tenant's runs paused for approval (the inbox).",
    ok: [AwaitingApprovalResponse],
  })
  @Get("awaiting")
  awaiting(
    @TenantId() tenantId: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<AwaitingApproval[]> {
    return this.executions.listAwaiting(tenantId, principal);
  }

  /** Decide many paused runs at once (same decision applied to each). Declared among the
   *  literal routes, before `:id`, so the `approve-batch` segment isn't captured as an :id. */
  @ApiEndpoint({
    summary: "Approve or reject many paused runs at once",
    description:
      "Batch decision — each run is signalled independently; a per-run outcome is returned so an already-closed or not-owned run doesn't fail the whole batch.",
    ok: [BatchDecisionItemResponse],
  })
  @Post("approve-batch")
  @HttpCode(200)
  approveBatch(
    @TenantId() tenantId: string,
    @Body() body: ApproveBatchDto,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<BatchDecisionResult[]> {
    return this.executions.approveBatch(
      body.ids,
      body.approved,
      tenantId,
      body.comment,
      principal,
    );
  }

  /** Archive/restore many runs at once. Literal route before `:id`, like approve-batch. */
  @ApiEndpoint({
    summary: "Archive or restore many runs at once",
    description:
      "Soft-archives (or restores) each listed run independently; a per-run outcome is returned so a not-owned/unknown id doesn't fail the whole batch.",
    ok: [BatchDecisionItemResponse],
  })
  @Post("archive-batch")
  @HttpCode(200)
  archiveBatch(
    @TenantId() tenantId: string,
    @Body() body: ArchiveBatchDto,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<BatchDecisionResult[]> {
    return this.executions.archiveBatch(
      body.ids,
      tenantId,
      body.archived,
      principal,
    );
  }

  /** Cancel many runs at once. Literal route before `:id`, like approve/archive-batch. */
  @ApiEndpoint({
    summary: "Cancel many runs at once",
    description:
      "Terminates each listed run independently and tenant-scoped; a per-run outcome is returned so an already-finished / not-owned / unknown id doesn't fail the whole batch.",
    ok: [BatchDecisionItemResponse],
  })
  @Post("cancel-batch")
  @HttpCode(200)
  cancelBatch(
    @TenantId() tenantId: string,
    @Body() body: CancelBatchDto,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<BatchDecisionResult[]> {
    return this.executions.cancelBatch(body.ids, tenantId, principal);
  }

  @ApiEndpoint({
    summary: "Approve or reject a paused run",
    description: "Signals the run's humanApproval decision (accepted async).",
    ok: AcceptedResponse,
    notFound: true,
  })
  @Post(":id/approve")
  @HttpCode(202) // explicit: NestJS would otherwise return 201 for a POST
  async approve(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @Body() body: ApproveDto,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<{ accepted: true }> {
    // G3: deciding an approval asserts `run` on the run's workflow. The PUBLIC signed-link
    // decision path (/approvals/:id/decide, HMAC-authorized) does NOT come through here.
    await this.executions.approve(
      id,
      body.approved,
      tenantId,
      body.comment,
      principal,
    );
    return { accepted: true };
  }

  /** Manual "Remind now" for a paused approval: re-fires the approval notification with a
   *  `reminder` flavor to the run env's enabled channels. 409 if no longer awaiting. */
  @ApiEndpoint({
    summary: "Send an approval reminder now",
    description:
      "Re-notifies the run environment's channels (reminder flavor) that this approval is still waiting. 409 if the run is no longer awaiting approval.",
    ok: RemindResponse,
    notFound: true,
  })
  @Post(":id/remind")
  @HttpCode(200)
  async remind(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<RemindResponse> {
    const info = await this.executions.remindContext(id, tenantId, principal);
    const { sent } = await this.notifications.sendApprovalReminder(
      tenantId,
      info.environmentId,
      info,
    );
    return { accepted: true, sent };
  }

  @ApiEndpoint({
    summary: "Cancel a running run",
    description:
      "Terminates the workflow (status → terminated). 409 if already finished.",
    ok: AcceptedResponse,
    notFound: true,
  })
  @Post(":id/cancel")
  @HttpCode(200)
  async cancel(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<{ accepted: true }> {
    await this.executions.cancel(id, tenantId, principal);
    return { accepted: true };
  }

  @ApiEndpoint({
    summary: "Archive a run",
    description:
      "Soft-hides the run from the default Runs list (read-model only — the workflow is untouched).",
    ok: AcceptedResponse,
    notFound: true,
  })
  @Post(":id/archive")
  @HttpCode(200)
  async archive(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<{ accepted: true }> {
    await this.executions.setArchived(id, tenantId, true, principal);
    return { accepted: true };
  }

  @ApiEndpoint({
    summary: "Restore an archived run",
    description:
      "Clears the archived flag so the run reappears in the Runs list.",
    ok: AcceptedResponse,
    notFound: true,
  })
  @Post(":id/unarchive")
  @HttpCode(200)
  async unarchive(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<{ accepted: true }> {
    await this.executions.setArchived(id, tenantId, false, principal);
    return { accepted: true };
  }

  @ApiEndpoint({
    summary: "Re-run a past run",
    description:
      "Starts a NEW run of the same workflow with the original trigger input. Re-runs against the current graph by default; pass `graphVersion` to re-run at a specific saved version (newer or older). 400 if the run predates workflow-key tracking; 404 if the version doesn't exist.",
    created: StartExecutionResponse,
    notFound: true,
  })
  @Post(":id/rerun")
  rerun(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    // Default to {} so a legacy caller that POSTs with no body (the pre-version
    // behaviour) still re-runs against the latest graph instead of hitting an
    // undefined-body read.
    @Body() body: RerunDto = {},
    @CurrentPrincipal() principal?: Principal,
  ): Promise<{ workflowId: string }> {
    return this.executions.rerun(id, tenantId, body?.graphVersion, principal);
  }

  @ApiEndpoint({
    summary: "Can this failed run be resumed at its failed node?",
    description:
      "Read BEFORE offering a resume, so the UI can disable the action and explain why. `resumable:false` carries a `reason` (and a human-readable `detail`): a resume is refused whenever restarting at one node would misrepresent the run's remaining work — inside a per-item region, at a loop/child node, after a real parallel fan-out, with no recorded failing node, or with no retrievable state snapshot. `warnings` is non-empty when the failing node may already have taken effect.",
    ok: ResumeEligibilityResponse,
    notFound: true,
  })
  @Get(":id/resume-eligibility")
  resumeEligibility(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<unknown> {
    return this.executions.resumeEligibility(id, tenantId, principal);
  }

  @ApiEndpoint({
    summary: "Resume a failed run at the node that failed",
    description:
      "Starts a NEW run seeded with the failed run's saved state, beginning AT the failed node — so nothing upstream executes again and side effects an earlier node already had are not repeated (which is what a plain re-run does). 409 with the reason when the run isn't resumable; 400 when the failing node may already have taken effect and `acknowledgeSideEffects` wasn't set.",
    created: StartExecutionResponse,
    notFound: true,
  })
  @Post(":id/resume")
  resume(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @Body() body: ResumeRunDto = {},
    @CurrentPrincipal() principal?: Principal,
  ): Promise<{ workflowId: string }> {
    return this.executions.resume(id, tenantId, body ?? {}, principal);
  }

  /** The signed resume URL for a run paused on a wait(webhook) node (owner-scoped). Declared
   *  before `:id` so the literal `resume-url` segment is matched specifically. */
  @ApiEndpoint({
    summary: "Get a run's webhook resume URL",
    ok: ResumeUrlResponse,
    notFound: true,
  })
  @Get(":id/resume-url")
  async resumeUrl(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<ResumeUrlResponse> {
    return {
      path: await this.executions.getResumePath(id, tenantId, principal),
    };
  }

  /** The graph SNAPSHOT this run executed (from Temporal history), for the run-detail canvas.
   *  (`:id/graph` and `:id` differ in segment count, so no route-ordering conflict.) */
  @ApiEndpoint({
    summary: "Get the graph a run executed",
    description:
      "The version-pinned graph snapshot the run actually walked (accurate even if the workflow was later edited).",
    ok: RunGraphResponse,
    notFound: true,
  })
  @Get(":id/graph")
  runGraph(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<{
    graph: Record<string, unknown>;
    version: number | null;
    workflowKey: string | null;
  }> {
    return this.executions.runGraph(id, tenantId, principal);
  }

  /**
   * Stream a node's synthesized AUDIO (textToSpeech, #689) so the run view can play/download it.
   *
   * Takes only (run id, node id) — the object reference is read out of the run ctx and checked
   * against this tenant's storage prefix. A client-supplied ref is NEVER accepted (that would be an
   * arbitrary cross-tenant object read). Declared BEFORE `GET :id` for readability; the 4-segment
   * path can't collide with it either way.
   */
  @ApiEndpoint({
    summary: "Download a node's synthesized audio (textToSpeech)",
    description:
      "Streams the audio object a `textToSpeech` node produced. 404 when the node produced no " +
      "audio or the object is no longer in storage (with the default in-memory store the objects " +
      "live in the worker process, so this is expected in a dev setup).",
    notFound: true,
  })
  @ApiProduces("audio/mpeg")
  @Get(":id/nodes/:nodeId/audio")
  async getNodeAudio(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @Param("nodeId") nodeId: string,
    @Res() res: ServerResponse,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<void> {
    const { body, contentType, filename } = await this.executions.nodeAudio(
      id,
      nodeId,
      tenantId,
      principal,
    );
    res.writeHead(200, {
      // Only an allow-listed audio type ever reaches this header (see safeContentType) — a stored
      // `text/html` would otherwise make an object read a stored-XSS sink.
      "content-type": contentType,
      "content-length": String(body.byteLength),
      // Inline so an <audio> element can play it; the filename drives "Save as".
      "content-disposition": `inline; filename="${filename}"`,
      // Belt-and-braces for a binary body served from a user-controlled bucket path.
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=300",
    });
    res.end(body);
  }

  @ApiEndpoint({
    summary: "Get a run's live state",
    ok: RunStateResponse,
    notFound: true,
  })
  @Get(":id")
  getState(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<RunStateView> {
    return this.executions.getState(id, tenantId, principal);
  }

  /** The run's execution log (curated Temporal history). */
  @ApiEndpoint({
    summary: "Get a run's execution log",
    description: "Curated Temporal history for the run.",
    ok: [RunEventResponse],
    notFound: true,
  })
  @Get(":id/history")
  history(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<RunEvent[]> {
    return this.executions.history(id, tenantId, principal);
  }
}
