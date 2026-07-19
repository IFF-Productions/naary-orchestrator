import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { CurrentPrincipal, type Principal } from "../auth/tenant.decorator";
import { UserScoped } from "../auth/user-scoped.decorator";
import { ApiEndpoint } from "../swagger/api-decorators";
import {
  CompanyGrantDto,
  CreateCompanyGroupDto,
  RenameCompanyGroupDto,
} from "./company-group.dto";
import {
  type CompanyGrantView,
  CompanyGroupsService,
  type CompanyGroupView,
} from "./company-groups.service";
import { CompanyGrantResponse, CompanyGroupResponse } from "./company.response";

/**
 * Company-wide permission groups (RBAC-GROUPS §9 / COMPANIES §9). All routes are
 * `@UserScoped()` and uid-keyed: company groups reach into every member workspace, so an
 * `nry_` API-token principal (no uid, workspace-scoped) is forbidden outright. Everything is
 * company-OWNER-gated in the service. v1 semantics the routes expose: one 'all'-scope,
 * all-environments grant per group; members are company members only; the grants UNION into
 * a member's workspace permissions ONLY where that workspace already restricts them — they
 * never flip a workspace's cliff.
 */
@ApiBearerAuth("bearer")
@Controller("companies/:id/groups")
export class CompanyGroupsController {
  constructor(private readonly groups: CompanyGroupsService) {}

  @ApiEndpoint({
    summary: "List the company's permission groups",
    description: "Every group with its members and grant. Company owner only.",
    ok: [CompanyGroupResponse],
  })
  @Get()
  @UserScoped()
  list(
    @CurrentPrincipal() principal: Principal,
    @Param("id") companyId: string,
  ): Promise<CompanyGroupView[]> {
    return this.groups.list(this.requireUser(principal), companyId);
  }

  @ApiEndpoint({
    summary: "Create a company permission group",
    description: "Name is unique per company (409). Company owner only.",
    created: CompanyGroupResponse,
    conflict: true,
  })
  @Post()
  @HttpCode(201)
  @UserScoped()
  create(
    @CurrentPrincipal() principal: Principal,
    @Param("id") companyId: string,
    @Body() body: CreateCompanyGroupDto,
  ): Promise<CompanyGroupView> {
    return this.groups.create(
      this.requireUser(principal),
      companyId,
      body.name,
    );
  }

  @ApiEndpoint({
    summary: "Rename a company permission group",
    ok: CompanyGroupResponse,
    notFound: true,
    conflict: true,
  })
  @Patch(":groupId")
  @UserScoped()
  rename(
    @CurrentPrincipal() principal: Principal,
    @Param("id") companyId: string,
    @Param("groupId") groupId: string,
    @Body() body: RenameCompanyGroupDto,
  ): Promise<CompanyGroupView> {
    return this.groups.rename(
      this.requireUser(principal),
      companyId,
      groupId,
      body.name,
    );
  }

  @ApiEndpoint({
    summary: "Delete a company permission group",
    description:
      "Removes the group with its members and grant — revoking that access in every attached workspace where the members were restricted.",
    notFound: true,
  })
  @Delete(":groupId")
  @HttpCode(204)
  @UserScoped()
  async remove(
    @CurrentPrincipal() principal: Principal,
    @Param("id") companyId: string,
    @Param("groupId") groupId: string,
  ): Promise<void> {
    await this.groups.remove(this.requireUser(principal), companyId, groupId);
  }

  @ApiEndpoint({
    summary: "Add a company member to a group",
    description:
      "The target (by Firebase uid) must hold a CompanyMembership in this company — 400 otherwise. Idempotent. Company owner only.",
    notFound: true,
  })
  @Post(":groupId/members/:userId")
  @HttpCode(204)
  @UserScoped()
  async addMember(
    @CurrentPrincipal() principal: Principal,
    @Param("id") companyId: string,
    @Param("groupId") groupId: string,
    @Param("userId") targetUserId: string,
  ): Promise<void> {
    await this.groups.addMember(
      this.requireUser(principal),
      companyId,
      groupId,
      targetUserId,
    );
  }

  @ApiEndpoint({
    summary: "Remove a member from a company group",
    notFound: true,
  })
  @Delete(":groupId/members/:userId")
  @HttpCode(204)
  @UserScoped()
  async removeMember(
    @CurrentPrincipal() principal: Principal,
    @Param("id") companyId: string,
    @Param("groupId") groupId: string,
    @Param("userId") targetUserId: string,
  ): Promise<void> {
    await this.groups.removeMember(
      this.requireUser(principal),
      companyId,
      groupId,
      targetUserId,
    );
  }

  @ApiEndpoint({
    summary: "Set the group's company-wide grant",
    description:
      "Upserts the group's single grant row (PUT replace semantics — absent verbs become false). " +
      "Applies to ALL workflows in ALL attached workspaces, every environment (v1). Only ADDS " +
      "access back for members a workspace has already restricted; never restricts anyone.",
    ok: CompanyGrantResponse,
    notFound: true,
  })
  @Put(":groupId/grant")
  @UserScoped()
  setGrant(
    @CurrentPrincipal() principal: Principal,
    @Param("id") companyId: string,
    @Param("groupId") groupId: string,
    @Body() body: CompanyGrantDto,
  ): Promise<CompanyGrantView> {
    return this.groups.setGrant(
      this.requireUser(principal),
      companyId,
      groupId,
      body,
    );
  }

  /** Company groups are uid-keyed — an API token can never manage (or hold) one. */
  private requireUser(principal: Principal): string {
    if (!principal.userId) {
      throw new ForbiddenException(
        "Company actions require a signed-in user account.",
      );
    }
    return principal.userId;
  }
}
