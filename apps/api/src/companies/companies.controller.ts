import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { CurrentPrincipal, type Principal } from "../auth/tenant.decorator";
import { UserScoped } from "../auth/user-scoped.decorator";
import { ApiEndpoint } from "../swagger/api-decorators";
import type { RunPage } from "../executions/executions.service";
import type { GraphSummary } from "../graphs/graphs.service";
import {
  type CompanyBudgetConfig,
  type CompanyBudgetView,
  type CompanyUsageRollup,
  type CompanyView,
  CompanyService,
} from "./company.service";
import {
  CompanyBudgetConfigResponse,
  CompanyBudgetViewResponse,
  CompanyUsageResponse,
  CompanyViewResponse,
  CompanyWorkspaceRunsResponse,
  CompanyWorkspaceWorkflowResponse,
} from "./company.response";
import { SetCompanyBudgetDto } from "./set-company-budget.dto";

/**
 * Companies (COMPANIES.md Slices 1–3). All routes are `@UserScoped()` and keyed by the caller's
 * Firebase uid — `CompanyMembership` is uid-keyed, so an `nry_` API-token principal (no uid) can't
 * hold one: list returns [], everything else is forbidden. Cross-workspace reads (usage rollup +
 * the Slice-3 runs/workflows visibility) are gated by company membership (§4) and are READ-ONLY.
 */
@ApiBearerAuth("bearer")
@Controller()
export class CompaniesController {
  constructor(private readonly companies: CompanyService) {}

  @ApiEndpoint({
    summary: "List the caller's companies",
    ok: [CompanyViewResponse],
  })
  @Get("me/companies")
  @UserScoped()
  async list(@CurrentPrincipal() principal: Principal): Promise<CompanyView[]> {
    // API-token principals have no user identity → no company memberships.
    if (!principal.userId) return [];
    return this.companies.listForUser(principal.userId);
  }

  @ApiEndpoint({
    summary: "Create a company",
    description: "The caller becomes its owner. Requires a signed-in user.",
    created: CompanyViewResponse,
  })
  @Post("companies")
  @HttpCode(201)
  @UserScoped()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: { name?: string },
  ): Promise<CompanyView> {
    const userId = this.requireUser(principal);
    return this.companies.create(userId, body?.name);
  }

  @ApiEndpoint({
    summary: "Company usage rollup",
    description:
      "Total + per-workspace (+ nested per-environment) spend across the company's member workspaces. " +
      "Company members only (§4 — the sole cross-workspace read). Optional from/to (ISO date) window. " +
      "Tokens + cost only.",
    ok: CompanyUsageResponse,
  })
  @Get("companies/:id/usage")
  @UserScoped()
  async usage(
    @CurrentPrincipal() principal: Principal,
    @Param("id") companyId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ): Promise<CompanyUsageRollup> {
    const userId = this.requireUser(principal);
    return this.companies.getCompanyUsage(userId, companyId, { from, to });
  }

  @ApiEndpoint({
    summary: "List a member workspace's runs (company console)",
    description:
      "READ-ONLY page of runs in one of the company's workspaces (§7.3). Company members only " +
      "(§4). Run detail stays workspace-gated — this returns summaries only.",
    ok: CompanyWorkspaceRunsResponse,
    notFound: true,
  })
  @Get("companies/:id/workspaces/:tenantId/runs")
  @UserScoped()
  async workspaceRuns(
    @CurrentPrincipal() principal: Principal,
    @Param("id") companyId: string,
    @Param("tenantId") tenantId: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ): Promise<RunPage> {
    const userId = this.requireUser(principal);
    // Garbage ?limit ("abc" → NaN) must not reach Prisma's `take`; listPage clamps the RANGE,
    // this guards the TYPE. Whitespace around a pasted cursor is trimmed, empty = absent.
    const parsedLimit = limit ? Number(limit) : undefined;
    const trimmedCursor = cursor?.trim() || undefined;
    return this.companies.listWorkspaceRuns(userId, companyId, tenantId, {
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
      cursor: trimmedCursor,
    });
  }

  @ApiEndpoint({
    summary: "List a member workspace's workflows (company console)",
    description:
      "READ-ONLY workflow summaries (names/keys — never graph bodies) from the workspace's " +
      "default environment (§7.3). Company members only (§4).",
    ok: [CompanyWorkspaceWorkflowResponse],
    notFound: true,
  })
  @Get("companies/:id/workspaces/:tenantId/workflows")
  @UserScoped()
  async workspaceWorkflows(
    @CurrentPrincipal() principal: Principal,
    @Param("id") companyId: string,
    @Param("tenantId") tenantId: string,
  ): Promise<GraphSummary[]> {
    const userId = this.requireUser(principal);
    return this.companies.listWorkspaceWorkflows(userId, companyId, tenantId);
  }

  @ApiEndpoint({
    summary: "Get the company's budget",
    description:
      "Company-wide monthly cap (COMPANIES.md §8, Slice 5) + live company-wide month-to-date " +
      "spend. Company members only. `budget` is null when no cap is configured.",
    ok: CompanyBudgetViewResponse,
  })
  @Get("companies/:id/budget")
  @UserScoped()
  async getBudget(
    @CurrentPrincipal() principal: Principal,
    @Param("id") companyId: string,
  ): Promise<CompanyBudgetView> {
    const userId = this.requireUser(principal);
    return this.companies.getCompanyBudget(userId, companyId);
  }

  @ApiEndpoint({
    summary: "Set the company's budget",
    description:
      "Company OWNER only — the cap gates run starts across every member workspace " +
      "(an OUTER gate above per-workspace budgets; both must pass).",
    ok: CompanyBudgetConfigResponse,
  })
  @Put("companies/:id/budget")
  @UserScoped()
  async setBudget(
    @CurrentPrincipal() principal: Principal,
    @Param("id") companyId: string,
    @Body() body: SetCompanyBudgetDto,
  ): Promise<CompanyBudgetConfig> {
    const userId = this.requireUser(principal);
    return this.companies.setCompanyBudget(userId, companyId, body);
  }

  @ApiEndpoint({
    summary: "Attach a workspace to a company",
    description:
      "Owner-authorized (§4): the caller must be a company member AND the workspace's owner.",
  })
  @Post("companies/:id/workspaces/:tenantId")
  @HttpCode(204)
  @UserScoped()
  async attach(
    @CurrentPrincipal() principal: Principal,
    @Param("id") companyId: string,
    @Param("tenantId") tenantId: string,
  ): Promise<void> {
    const userId = this.requireUser(principal);
    await this.companies.attachWorkspace(userId, companyId, tenantId, {
      activeTenantId: principal.tenantId || undefined,
      activeRole: principal.role,
    });
  }

  @ApiEndpoint({
    summary: "Detach a workspace from a company",
    description:
      "Allowed from either side: a company admin or the workspace owner.",
  })
  @Delete("companies/:id/workspaces/:tenantId")
  @HttpCode(204)
  @UserScoped()
  async detach(
    @CurrentPrincipal() principal: Principal,
    @Param("id") companyId: string,
    @Param("tenantId") tenantId: string,
  ): Promise<void> {
    const userId = this.requireUser(principal);
    await this.companies.detachWorkspace(userId, companyId, tenantId, {
      activeTenantId: principal.tenantId || undefined,
      activeRole: principal.role,
    });
  }

  /** Companies are keyed by Firebase uid — an API token can't own/administer one. */
  private requireUser(principal: Principal): string {
    if (!principal.userId) {
      throw new ForbiddenException(
        "Company actions require a signed-in user account.",
      );
    }
    return principal.userId;
  }
}
