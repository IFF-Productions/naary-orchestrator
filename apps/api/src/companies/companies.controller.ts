import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { CurrentPrincipal, type Principal } from "../auth/tenant.decorator";
import { UserScoped } from "../auth/user-scoped.decorator";
import { ApiEndpoint } from "../swagger/api-decorators";
import {
  type CompanyUsageRollup,
  type CompanyView,
  CompanyService,
} from "./company.service";
import { CompanyUsageResponse, CompanyViewResponse } from "./company.response";

/**
 * Companies (COMPANIES.md Slices 1–2). All routes are `@UserScoped()` and keyed by the caller's
 * Firebase uid — `CompanyMembership` is uid-keyed, so an `nry_` API-token principal (no uid) can't
 * hold one: list returns [], everything else is forbidden. The only cross-workspace read is the
 * usage rollup, gated by company membership (§4).
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
