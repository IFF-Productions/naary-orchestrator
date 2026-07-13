import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { TenantId } from "../auth/tenant.decorator";
import { ApiEndpoint } from "../swagger/api-decorators";
import {
  ApproveBatchDto,
  ApproveDto,
  StartExecutionDto,
} from "./execution.dto";
import {
  AcceptedResponse,
  AwaitingApprovalResponse,
  BatchDecisionItemResponse,
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
  constructor(private readonly executions: ExecutionsService) {}

  @ApiEndpoint({
    summary: "Start a run",
    description: "Starts a run of the given workflow (defaults to 'default').",
    created: StartExecutionResponse,
  })
  @Post()
  start(
    @TenantId() tenantId: string,
    @Body() body: StartExecutionDto,
  ): Promise<{ workflowId: string }> {
    return this.executions.start(tenantId, body.input, body.workflowKey);
  }

  /** Recent runs for the authenticated tenant (newest first). */
  @ApiEndpoint({
    summary: "List recent runs",
    description: "Recent runs for the tenant (newest first).",
    ok: [RunListItemResponse],
  })
  @Get()
  listRuns(
    @TenantId() tenantId: string,
  ): Promise<{ workflowId: string; createdAt: string }[]> {
    return this.executions.list(tenantId);
  }

  /** The tenant's runs paused for approval, each with its prompt (the inbox). Must
   *  be declared BEFORE `@Get(":id")` so "awaiting" isn't captured as an :id. */
  @ApiEndpoint({
    summary: "List runs awaiting approval",
    description: "The tenant's runs paused for approval (the inbox).",
    ok: [AwaitingApprovalResponse],
  })
  @Get("awaiting")
  awaiting(@TenantId() tenantId: string): Promise<AwaitingApproval[]> {
    return this.executions.listAwaiting(tenantId);
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
  ): Promise<BatchDecisionResult[]> {
    return this.executions.approveBatch(
      body.ids,
      body.approved,
      tenantId,
      body.comment,
    );
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
  ): Promise<{ accepted: true }> {
    await this.executions.approve(id, body.approved, tenantId, body.comment);
    return { accepted: true };
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
  ): Promise<{ accepted: true }> {
    await this.executions.cancel(id, tenantId);
    return { accepted: true };
  }

  @ApiEndpoint({
    summary: "Re-run a past run",
    description:
      "Starts a NEW run of the same workflow with the original trigger input (against the current graph). 400 if the run predates workflow-key tracking.",
    created: StartExecutionResponse,
    notFound: true,
  })
  @Post(":id/rerun")
  rerun(
    @TenantId() tenantId: string,
    @Param("id") id: string,
  ): Promise<{ workflowId: string }> {
    return this.executions.rerun(id, tenantId);
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
  ): Promise<{ graph: Record<string, unknown> }> {
    return this.executions.runGraph(id, tenantId);
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
  ): Promise<RunStateView> {
    return this.executions.getState(id, tenantId);
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
  ): Promise<RunEvent[]> {
    return this.executions.history(id, tenantId);
  }
}
