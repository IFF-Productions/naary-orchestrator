import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiQuery } from "@nestjs/swagger";
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
  RunStateResponse,
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
  ): Promise<BatchDecisionResult[]> {
    return this.executions.archiveBatch(body.ids, tenantId, body.archived);
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
  ): Promise<{ accepted: true }> {
    await this.executions.setArchived(id, tenantId, true);
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
  ): Promise<{ accepted: true }> {
    await this.executions.setArchived(id, tenantId, false);
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
  ): Promise<ResumeUrlResponse> {
    return { path: await this.executions.getResumePath(id, tenantId) };
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
