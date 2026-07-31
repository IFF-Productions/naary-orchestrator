/**
 * Self-healing endpoints (Phase 2): the per-workflow opt-in, the proposal inbox, and the decision.
 *
 * Everything consequential happens in `HealService`; this is the HTTP shape. Notably the approve
 * route does NOT check permissions itself — it hands the principal to a path that ends in
 * `graphs.upsert()`, whose save gate enforces `edit`. Re-checking here would be a second opinion
 * about the same question, and the two could drift.
 */
import { Body, Controller, Get, Param, Post, Put, Query } from "@nestjs/common";
import {
  CurrentPrincipal,
  EnvironmentSel,
  type Principal,
  TenantId,
} from "../auth/tenant.decorator";
import { EnvironmentsService } from "../environments/environments.service";
import { ApiEndpoint } from "../swagger/api-decorators";
import { HealService, type FixProposalView } from "./heal.service";
import {
  FixProposalDetailResponse,
  FixProposalResponse,
  SelfHealSettingResponse,
} from "./heal.response";
import { SetSelfHealDto } from "./heal.dto";

@Controller()
export class HealController {
  constructor(
    private readonly heal: HealService,
    private readonly environments: EnvironmentsService,
  ) {}

  @ApiEndpoint({
    summary: "Is self-healing enabled for this workflow?",
    ok: SelfHealSettingResponse,
  })
  @Get("graphs/:workflowKey/self-heal")
  async get(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<{ enabled: boolean }> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return { enabled: await this.heal.isEnabled(tenantId, envId, workflowKey) };
  }

  @ApiEndpoint({
    summary: "Turn self-healing on or off for a workflow",
    ok: SelfHealSettingResponse,
  })
  @Put("graphs/:workflowKey/self-heal")
  async set(
    @TenantId() tenantId: string,
    @Param("workflowKey") workflowKey: string,
    @Body() body: SetSelfHealDto,
    @EnvironmentSel() envSel?: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<{ enabled: boolean }> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.heal.setEnabled(
      tenantId,
      envId,
      workflowKey,
      body.enabled,
      principal,
    );
  }

  @ApiEndpoint({
    summary: "List proposed fixes awaiting review",
    ok: [FixProposalResponse],
  })
  @Get("fix-proposals")
  async list(
    @TenantId() tenantId: string,
    @Query("status") status?: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<FixProposalView[]> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.heal.list(tenantId, envId, status || "pending");
  }

  @ApiEndpoint({
    summary: "One proposed fix, with the graph it proposes",
    ok: FixProposalDetailResponse,
  })
  @Get("fix-proposals/:id")
  async detail(@TenantId() tenantId: string, @Param("id") id: string) {
    return this.heal.get(tenantId, id);
  }

  /**
   * Approve — which APPLIES the fix as a new workflow version.
   *
   * The `edit` permission is enforced downstream by the save gate, and staleness is re-checked
   * against the live latest version at this moment rather than trusted from proposal time: a
   * proposal may have sat for days while someone edited the workflow by hand, and applying then
   * would silently revert their work.
   */
  @ApiEndpoint({
    summary: "Approve a proposed fix (writes a new workflow version)",
    ok: FixProposalResponse,
  })
  @Post("fix-proposals/:id/approve")
  async approve(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<{ status: string; appliedVersion?: number }> {
    return this.heal.approve(tenantId, id, principal);
  }

  @ApiEndpoint({
    summary: "Reject a proposed fix",
    ok: FixProposalResponse,
  })
  @Post("fix-proposals/:id/reject")
  async reject(
    @TenantId() tenantId: string,
    @Param("id") id: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<{ status: string }> {
    return this.heal.reject(tenantId, id, principal);
  }
}
