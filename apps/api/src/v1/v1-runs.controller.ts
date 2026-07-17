import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { EnvironmentSel, TenantId } from "../auth/tenant.decorator";
import { EnvironmentsService } from "../environments/environments.service";
import {
  type AwaitingApproval,
  type RunEvent,
  ExecutionsService,
  type RunStateView,
} from "../executions/executions.service";
import { ApiEndpoint } from "../swagger/api-decorators";
import { ApiTokenThrottlerGuard } from "./api-token-throttler.guard";
import { ApproveRunDto, RerunRunDto, StartRunDto } from "./v1-run.dto";
import {
  AwaitingRunResponse,
  RunActionResponse,
  RunDetailResponse,
  RunHistoryEventResponse,
  RunListItemResponse,
  RunRefResponse,
} from "./v1-run.response";

/**
 * Parse the public `?limit=` query into a safe integer in 1..100 (default 50). Rejects non-integers
 * ("10.5"), negatives/zero, and garbage — so a predictable value always reaches the service/Prisma
 * `take`, never a float or a NaN. Exported for direct unit testing.
 */
export function parseLimit(raw: string | undefined): number {
  const DEFAULT = 50;
  if (raw === undefined || raw.trim() === "") return DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n)) return DEFAULT;
  return Math.min(Math.max(n, 1), 100);
}

/**
 * Public v1 run API — the "run" resource aliases the internal "execution". Thin: every method calls
 * the SAME ExecutionsService the SPA uses (so a run started here meters usage + is durable exactly
 * like a UI/MCP-started one), and maps the internal result into a v1-OWNED response DTO (§5 — the
 * public contract must not drift with internal type churn). tenantId comes from the token (never a
 * path/body arg — the cross-tenant isolation invariant). Rate-limited PER TOKEN
 * ({@link ApiTokenThrottlerGuard}), additive to the global per-IP throttler.
 *
 * Mounted at v1/runs; the `/api` prefix is stripped by the web proxy/nginx, so callers hit
 * /api/v1/runs. Slice 1 = start + the run read paths; slice 2 adds the lifecycle actions
 * (cancel/rerun/approve) + the awaiting-approval inbox.
 */
@ApiTags("v1")
@ApiBearerAuth("bearer")
@UseGuards(ApiTokenThrottlerGuard)
@Controller("v1/runs")
export class V1RunsController {
  constructor(
    private readonly executions: ExecutionsService,
    private readonly environments: EnvironmentsService,
  ) {}

  @ApiEndpoint({
    summary: "Start a run",
    description:
      "Starts a run of the given workflow (defaults to 'default'). Returns the run id.",
    created: RunRefResponse,
  })
  @Post()
  async start(
    @TenantId() tenantId: string,
    @Body() body: StartRunDto,
    @EnvironmentSel() envSel?: string,
  ): Promise<RunRefResponse> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    const { workflowId } = await this.executions.start(
      tenantId,
      envId,
      body.input,
      body.workflowKey,
    );
    return { runId: workflowId };
  }

  @ApiEndpoint({
    summary: "List runs",
    description: "Most-recent runs for the token's tenant (newest first).",
    ok: [RunListItemResponse],
  })
  @Get()
  async list(
    @TenantId() tenantId: string,
    @Query("limit") limit?: string,
  ): Promise<RunListItemResponse[]> {
    // Coerce + clamp at the PUBLIC boundary so the API behaves predictably: a non-integer
    // ("10.5"), a negative, or garbage never reaches Prisma `take`. Default 50, bounded 1..100
    // (the service clamps too, but the public contract shouldn't rely on that).
    const rows = await this.executions.list(tenantId, parseLimit(limit));
    return rows.map((r) => ({
      runId: r.workflowId,
      workflowKey: r.workflowKey,
      status: r.status,
      costUsd: r.costUsd,
      startedAt: r.startedAt,
      graphVersion: r.graphVersion,
    }));
  }

  @ApiEndpoint({
    summary: "List runs awaiting approval",
    description:
      "Runs currently paused on a human-approval node, each with the approval prompt — the `approvals list` inbox.",
    ok: [AwaitingRunResponse],
  })
  // MUST be declared before `@Get(":id")`, or Express captures "awaiting" as an :id.
  @Get("awaiting")
  async awaiting(@TenantId() tenantId: string): Promise<AwaitingRunResponse[]> {
    const rows: AwaitingApproval[] =
      await this.executions.listAwaiting(tenantId);
    return rows.map((r) => ({
      runId: r.workflowId,
      workflowKey: r.workflowKey,
      nodeId: r.nodeId,
      title: r.title,
      instructions: r.instructions,
      createdAt: r.createdAt,
    }));
  }

  @ApiEndpoint({
    summary: "Get a run",
    description: "Live status, current node, and output context for one run.",
    ok: RunDetailResponse,
    notFound: true,
  })
  @Get(":id")
  async get(
    @TenantId() tenantId: string,
    @Param("id") id: string,
  ): Promise<RunDetailResponse> {
    const s: RunStateView = await this.executions.getState(id, tenantId);
    return {
      runId: id,
      status: s.status,
      currentNodeId: s.currentNodeId,
      output: s.ctx,
    };
  }

  @ApiEndpoint({
    summary: "Get a run's history",
    description: "The run's curated event timeline (for `runs watch`).",
    ok: [RunHistoryEventResponse],
    notFound: true,
  })
  @Get(":id/history")
  async history(
    @TenantId() tenantId: string,
    @Param("id") id: string,
  ): Promise<RunHistoryEventResponse[]> {
    const events: RunEvent[] = await this.executions.history(id, tenantId);
    return events.map((e) => ({
      id: e.id,
      kind: e.kind,
      label: e.label,
      at: e.at,
      detail: e.detail,
    }));
  }

  @ApiEndpoint({
    summary: "Cancel a run",
    description:
      "Terminates a running or paused run (status → terminated). 409 if it's already finished.",
    ok: RunActionResponse,
    notFound: true,
    conflict: true,
  })
  @Post(":id/cancel")
  @HttpCode(200) // NestJS would otherwise return 201 for a POST
  async cancel(
    @TenantId() tenantId: string,
    @Param("id") id: string,
  ): Promise<RunActionResponse> {
    await this.executions.cancel(id, tenantId);
    return { accepted: true };
  }

  @ApiEndpoint({
    summary: "Re-run a past run",
    description:
      "Starts a NEW run of the same workflow with the original trigger input. Re-runs against the current graph by default; pass `graphVersion` to pin a saved version. 400 if the run predates workflow-key tracking; 404 if the version doesn't exist.",
    created: RunRefResponse,
    notFound: true,
  })
  @Post(":id/rerun")
  async rerun(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    // Default to {} so a bodyless POST re-runs against the latest graph (never an undefined-body read).
    @Body() body: RerunRunDto = {},
  ): Promise<RunRefResponse> {
    const { workflowId } = await this.executions.rerun(
      id,
      tenantId,
      body?.graphVersion,
    );
    return { runId: workflowId };
  }

  @ApiEndpoint({
    summary: "Approve or reject a run",
    description:
      "Decides a run paused on a human-approval node. `approved:false` rejects it. 409 if the run is no longer awaiting approval.",
    accepted: RunActionResponse, // 202 — matches @HttpCode(202); the decision is signalled, not applied inline
    notFound: true,
    conflict: true,
  })
  @Post(":id/approve")
  @HttpCode(202) // explicit: the decision is signalled to the durable run, not applied inline
  async approve(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @Body() body: ApproveRunDto,
  ): Promise<RunActionResponse> {
    await this.executions.approve(id, body.approved, tenantId, body.comment);
    return { accepted: true };
  }
}
