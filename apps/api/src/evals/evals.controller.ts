import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import type { EvalDatasetBody } from "@naary/dsl/dist/assertions";
import {
  CurrentPrincipal,
  EnvironmentSel,
  type Principal,
  TenantId,
} from "../auth/tenant.decorator";
import { EnvironmentsService } from "../environments/environments.service";
import { ApiEndpoint } from "../swagger/api-decorators";
import {
  EvalCaseResultsResponse,
  EvalDatasetListResponse,
  EvalRunResponse,
} from "./evals.response";
import {
  type EvalCaseResultView,
  type EvalDatasetView,
  type EvalRunView,
  EvalsService,
} from "./evals.service";

/**
 * Workflow evals (#575) — golden datasets + batch eval runs, scoped to one workflow.
 *
 * Env resolution + RBAC follow the pins/graphs pattern: `@EnvironmentSel()` → `resolveEnvId` at the
 * boundary, then the SERVICE asserts the verb (`view` / `edit` / `run`) so the same authorization
 * also covers any non-HTTP caller.
 */
@ApiBearerAuth("bearer")
@Controller("graphs/:workflowKey/evals")
export class EvalsController {
  constructor(
    private readonly evals: EvalsService,
    private readonly environments: EnvironmentsService,
  ) {}

  @ApiEndpoint({
    summary: "List the workflow's golden eval datasets",
    ok: EvalDatasetListResponse,
  })
  @Get("datasets")
  async listDatasets(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @EnvironmentSel() envSel?: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<EvalDatasetView[]> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.evals.listDatasets(tenantId, envId, workflowKey, principal);
  }

  @ApiEndpoint({
    summary: "Get one golden dataset's cases + assertions",
    notFound: true,
  })
  @Get("datasets/:name")
  async getDataset(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @Param("name") name: string,
    @EnvironmentSel() envSel?: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<EvalDatasetBody> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.evals.getDataset(tenantId, envId, workflowKey, name, principal);
  }

  @ApiEndpoint({ summary: "Create or replace a golden dataset" })
  @Put("datasets/:name")
  async saveDataset(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @Param("name") name: string,
    // Untyped body: the shape is validated by `evalDatasetBodySchema` (zod) in the service, the SAME
    // schema the eval activity parses stored bodies with. A parallel class-validator DTO would be a
    // second, drifting definition of the contract.
    @Body() body: unknown,
    @EnvironmentSel() envSel?: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<EvalDatasetView> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.evals.saveDataset(
      tenantId,
      envId,
      workflowKey,
      name,
      body,
      principal,
    );
  }

  @ApiEndpoint({ summary: "Delete a golden dataset" })
  @Delete("datasets/:name")
  @HttpCode(204)
  async deleteDataset(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @Param("name") name: string,
    @EnvironmentSel() envSel?: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<void> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    await this.evals.deleteDataset(
      tenantId,
      envId,
      workflowKey,
      name,
      principal,
    );
  }

  @ApiEndpoint({
    summary: "Start a batch eval against a golden dataset",
    created: EvalRunResponse,
    notFound: true,
  })
  @Post("runs")
  @HttpCode(202)
  async startRun(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @Body() body: { dataset: string },
    @EnvironmentSel() envSel?: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<EvalRunView> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.evals.startRun(
      tenantId,
      envId,
      workflowKey,
      body?.dataset,
      principal,
    );
  }

  @ApiEndpoint({
    summary:
      "Eval-run history (each row carries the graph version + content hash it measured)",
    ok: EvalRunResponse,
  })
  @Get("runs")
  async listRuns(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @Query("limit") limit?: string,
    @EnvironmentSel() envSel?: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<EvalRunView[]> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.evals.listRuns(
      tenantId,
      envId,
      workflowKey,
      limit ? Number(limit) : undefined,
      principal,
    );
  }
}

/** Run drill-down, keyed by eval-run id (not workflow-scoped, like `GET /executions/:id`). */
@ApiBearerAuth("bearer")
@Controller("evals/runs")
export class EvalRunsController {
  constructor(private readonly evals: EvalsService) {}

  @ApiEndpoint({
    summary: "One eval run with its per-case verdicts",
    ok: EvalCaseResultsResponse,
    notFound: true,
  })
  @Get(":id")
  getRun(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<EvalRunView & { cases: EvalCaseResultView[] }> {
    return this.evals.getRun(tenantId, id, principal);
  }
}
