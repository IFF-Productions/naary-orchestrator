import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { GraphDef } from "@naary/dsl";
import {
  CurrentPrincipal,
  EnvironmentSel,
  type Principal,
  TenantId,
} from "../auth/tenant.decorator";
import { EnvironmentsService } from "../environments/environments.service";
import { GraphsService } from "../graphs/graphs.service";
import { WorkflowLifecycleService } from "../graphs/workflow-lifecycle.service";
import { ApiEndpoint } from "../swagger/api-decorators";
import { ApiTokenThrottlerGuard } from "./api-token-throttler.guard";
import { ImportWorkflowDto, PromoteWorkflowDto } from "./v1-workflow.dto";
import {
  PromotionLineageResponse,
  WorkflowDeletedResponse,
  WorkflowExportResponse,
  WorkflowPromotionResponse,
  WorkflowSavedResponse,
  WorkflowSummaryResponse,
} from "./v1-workflow.response";

/**
 * Guard the top-level graph shape so a non-graph body is a 400, not a 500 inside `upsert`'s
 * validateGraph (which does `graph.nodes.map(...)` and assumes arrays). Deep rules are validateGraph's.
 * Mirrors the internal graphs.controller's `toGraphDef` (kept local so v1 stays self-contained).
 */
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

/**
 * Public v1 workflow API — the "workflow" resource is the internal versioned "graph" (keyed by
 * workflowKey). Thin over the SAME GraphsService the SPA uses, mapping into v1-OWNED response DTOs
 * (§5). tenantId comes from the token; the env from X-Environment-Id / an env-bound token (never a
 * path/body arg). Rate-limited per token ({@link ApiTokenThrottlerGuard}).
 *
 * Export/import are symmetric: `GET :key` returns { workflowKey, name, version, graph } and `PUT :key`
 * accepts { name, graph } — so `export > file.json` then `import < file.json` round-trips.
 *
 * NOTE (schedule side-effects): create (PUT) and delete go through WorkflowLifecycleService — the
 * ONE consolidated save/delete path shared with graphs.controller — which owns the DEFAULT-ENV-only,
 * best-effort schedule sync/teardown (schedules aren't env-scoped yet, so doing it from a
 * non-default env would clobber the default/prod copy's triggers; without it, a workflow imported
 * via the API with a poll/cron trigger would silently never fire).
 *
 * Mounted at v1/workflows; the `/api` prefix is stripped by the web proxy/nginx, so callers hit
 * /api/v1/workflows.
 */
@ApiTags("v1")
@ApiBearerAuth("bearer")
@UseGuards(ApiTokenThrottlerGuard)
@Controller("v1/workflows")
export class V1WorkflowsController {
  constructor(
    private readonly graphs: GraphsService,
    private readonly environments: EnvironmentsService,
    private readonly lifecycle: WorkflowLifecycleService,
  ) {}

  @ApiEndpoint({
    summary: "List workflows",
    description:
      "One entry per workflow (its latest version) in the active environment. Names/keys only — no graph bodies.",
    ok: [WorkflowSummaryResponse],
  })
  @Get()
  async list(
    @TenantId() tenantId: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<WorkflowSummaryResponse[]> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    const rows = await this.graphs.list(tenantId, envId);
    return rows.map((r) => ({
      workflowKey: r.workflowKey,
      name: r.name,
      version: r.version,
      updatedAt: r.updatedAt,
      active: r.active,
    }));
  }

  @ApiEndpoint({
    summary: "Get / export a workflow",
    description:
      "The active env's latest graph for this workflow, as a portable document you can PUT back to import.",
    ok: WorkflowExportResponse,
    notFound: true,
  })
  @Get(":key")
  async get(
    @TenantId() tenantId: string,
    @Param("key") key: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<WorkflowExportResponse> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    const doc = await this.graphs.getLatestNamed(tenantId, envId, key);
    if (!doc) throw new NotFoundException(`No workflow '${key}'`);
    return {
      workflowKey: doc.workflowKey,
      name: doc.name,
      version: doc.version,
      graph: doc.graph as unknown as Record<string, unknown>,
    };
  }

  @ApiEndpoint({
    summary: "Create or update (import) a workflow",
    description:
      "Upserts the workflow at this key in the active env (content-hashed — an unchanged graph reuses its version). 400 if the graph is malformed.",
    ok: WorkflowSavedResponse,
    notFound: true,
  })
  @Put(":key")
  async put(
    @TenantId() tenantId: string,
    @Param("key") key: string,
    @Body() body: ImportWorkflowDto,
    @EnvironmentSel() envSel?: string,
  ): Promise<WorkflowSavedResponse> {
    const graph = toGraphDef(body.graph);
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    // Consolidated save path (shared with graphs.controller): upsert + the DEFAULT-ENV-ONLY,
    // best-effort poll/cron schedule sync live in WorkflowLifecycleService.
    const snap = await this.lifecycle.saveWorkflow(
      tenantId,
      envId,
      key,
      body.name,
      graph,
    );
    return {
      workflowKey: key,
      version: snap.version,
      contentHash: snap.contentHash,
    };
  }

  @ApiEndpoint({
    summary: "Delete a workflow",
    description:
      "Removes this workflow's definition (and its schedules/triggers when deleting the default env's copy) in the active env.",
    ok: WorkflowDeletedResponse,
    notFound: true,
  })
  @Delete(":key")
  async remove(
    @TenantId() tenantId: string,
    @Param("key") key: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<{ deleted: true }> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    // Consolidated delete path (shared with graphs.controller): the DEFAULT-ENV-ONLY, best-effort
    // schedule teardown + deleteShared gating live in WorkflowLifecycleService.
    const deleted = await this.lifecycle.deleteWorkflow(tenantId, envId, key);
    if (!deleted) throw new NotFoundException(`No workflow '${key}'`);
    return { deleted: true };
  }

  @ApiEndpoint({
    summary: "Promote a workflow to another environment",
    description:
      "Copies the active env's graph (a chosen version, default latest) into the target env as a new version, recording lineage. Credentials/connections are not copied.",
    created: WorkflowPromotionResponse,
    notFound: true,
  })
  @Post(":key/promote")
  async promote(
    @TenantId() tenantId: string,
    @Param("key") key: string,
    @Body() body: PromoteWorkflowDto,
    @CurrentPrincipal() principal: Principal,
    @EnvironmentSel() envSel?: string,
  ): Promise<WorkflowPromotionResponse> {
    const fromEnvId = await this.environments.resolveEnvId(tenantId, envSel);
    const toEnvId = await this.environments.resolveEnvId(tenantId, body.toEnv);
    // API-token principals have no subject/userId → 'api-token' (matches graphs.controller).
    const actor = principal.subject ?? principal.userId ?? "api-token";
    return this.graphs.promote(
      tenantId,
      key,
      fromEnvId,
      toEnvId,
      actor,
      body.fromVersion,
    );
  }

  @ApiEndpoint({
    summary: "List a workflow's promotions",
    description:
      "Who promoted this workflow between envs, when, and the source→target versions (newest first).",
    ok: [PromotionLineageResponse],
  })
  @Get(":key/promotions")
  async promotions(
    @TenantId() tenantId: string,
    @Param("key") key: string,
  ): Promise<PromotionLineageResponse[]> {
    const rows = await this.graphs.listPromotions(tenantId, key);
    return rows.map((r) => ({
      fromEnvId: r.fromEnvId,
      toEnvId: r.toEnvId,
      fromVersion: r.fromVersion,
      toVersion: r.toVersion,
      actor: r.actor,
      createdAt: r.createdAt,
    }));
  }
}
