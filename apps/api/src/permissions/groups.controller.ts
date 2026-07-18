import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { CurrentPrincipal, type Principal } from "../auth/tenant.decorator";
import { ApiEndpoint } from "../swagger/api-decorators";
import { CreateGroupDto, GrantDto, RenameGroupDto } from "./group.dto";
import { GrantResponse, GroupResponse } from "./group.response";
import {
  type GrantView,
  GroupsService,
  type GroupView,
} from "./groups.service";

/**
 * Permission-group management (RBAC-GROUPS.md §3/§4, slice G1 — API only; the Groups UI is
 * G2). tenantId comes from the path; the global AuthGuard enforces path-tenant ==
 * principal-tenant, and the service gates every method owner|admin (`share` grants no
 * group-editing power, §8.2). Creating the FIRST grant in a workspace flips its `member`
 * users AND ungrouped API tokens to deny-by-default — the cliff (§4/§8.6).
 */
@ApiBearerAuth("bearer")
@Controller("tenants/:id/groups")
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @ApiEndpoint({
    summary: "List permission groups",
    description:
      "Every group in the workspace with its members, attached API tokens, and grants. Owner/admin only.",
    ok: [GroupResponse],
  })
  @Get()
  list(
    @Param("id") tenantId: string,
    @CurrentPrincipal() caller: Principal,
  ): Promise<GroupView[]> {
    return this.groups.list(tenantId, caller);
  }

  @ApiEndpoint({
    summary: "Create a permission group",
    description:
      "Name is unique per workspace (409 on duplicate). Owner/admin only.",
    created: GroupResponse,
    conflict: true,
  })
  @Post()
  @HttpCode(201)
  create(
    @Param("id") tenantId: string,
    @CurrentPrincipal() caller: Principal,
    @Body() body: CreateGroupDto,
  ): Promise<GroupView> {
    return this.groups.create(tenantId, caller, body.name);
  }

  @ApiEndpoint({
    summary: "Rename a permission group",
    ok: GroupResponse,
    notFound: true,
    conflict: true,
  })
  @Patch(":groupId")
  rename(
    @Param("id") tenantId: string,
    @CurrentPrincipal() caller: Principal,
    @Param("groupId") groupId: string,
    @Body() body: RenameGroupDto,
  ): Promise<GroupView> {
    return this.groups.rename(tenantId, caller, groupId, body.name);
  }

  @ApiEndpoint({
    summary: "Delete a permission group",
    description:
      "Removes the group with its members, token attachments, and grants. Deleting the workspace's last grant lifts the restriction cliff.",
    notFound: true,
  })
  @Delete(":groupId")
  @HttpCode(204)
  async remove(
    @Param("id") tenantId: string,
    @CurrentPrincipal() caller: Principal,
    @Param("groupId") groupId: string,
  ): Promise<void> {
    await this.groups.remove(tenantId, caller, groupId);
  }

  // ---- members ----

  @ApiEndpoint({
    summary: "Add a workspace member to a group",
    description:
      "The target (by Firebase uid) must already hold a Membership in this workspace — 400 otherwise. Idempotent.",
    notFound: true,
  })
  @Post(":groupId/members/:userId")
  @HttpCode(204)
  async addMember(
    @Param("id") tenantId: string,
    @CurrentPrincipal() caller: Principal,
    @Param("groupId") groupId: string,
    @Param("userId") userId: string,
  ): Promise<void> {
    await this.groups.addMember(tenantId, caller, groupId, userId);
  }

  @ApiEndpoint({
    summary: "Remove a member from a group",
    notFound: true,
  })
  @Delete(":groupId/members/:userId")
  @HttpCode(204)
  async removeMember(
    @Param("id") tenantId: string,
    @CurrentPrincipal() caller: Principal,
    @Param("groupId") groupId: string,
    @Param("userId") userId: string,
  ): Promise<void> {
    await this.groups.removeMember(tenantId, caller, groupId, userId);
  }

  // ---- API tokens as subjects (§4a) ----

  @ApiEndpoint({
    summary: "Attach an API token to a group",
    description:
      "Restricted tokens get their access back through group grants. The token must belong to this workspace — 400 otherwise. Idempotent.",
    notFound: true,
  })
  @Post(":groupId/tokens/:tokenId")
  @HttpCode(204)
  async addToken(
    @Param("id") tenantId: string,
    @CurrentPrincipal() caller: Principal,
    @Param("groupId") groupId: string,
    @Param("tokenId") tokenId: string,
  ): Promise<void> {
    await this.groups.addToken(tenantId, caller, groupId, tokenId);
  }

  @ApiEndpoint({
    summary: "Detach an API token from a group",
    notFound: true,
  })
  @Delete(":groupId/tokens/:tokenId")
  @HttpCode(204)
  async removeToken(
    @Param("id") tenantId: string,
    @CurrentPrincipal() caller: Principal,
    @Param("groupId") groupId: string,
    @Param("tokenId") tokenId: string,
  ): Promise<void> {
    await this.groups.removeToken(tenantId, caller, groupId, tokenId);
  }

  // ---- grants ----

  @ApiEndpoint({
    summary: "Create a grant on a group",
    description:
      "Six-verb, env-scoped grant (null env = all environments). canCreate requires scope 'all' (400). The workspace's FIRST grant restricts all members and all ungrouped API tokens.",
    created: GrantResponse,
    notFound: true,
  })
  @Post(":groupId/grants")
  @HttpCode(201)
  createGrant(
    @Param("id") tenantId: string,
    @CurrentPrincipal() caller: Principal,
    @Param("groupId") groupId: string,
    @Body() body: GrantDto,
  ): Promise<GrantView> {
    return this.groups.createGrant(tenantId, caller, groupId, body);
  }

  @ApiEndpoint({
    summary: "Update a grant",
    description:
      "PATCH semantics — absent fields keep their value; workflowKeys is a replace-set. The RESULTING canCreate×scope combination is validated (400).",
    ok: GrantResponse,
    notFound: true,
  })
  @Patch(":groupId/grants/:grantId")
  updateGrant(
    @Param("id") tenantId: string,
    @CurrentPrincipal() caller: Principal,
    @Param("groupId") groupId: string,
    @Param("grantId") grantId: string,
    @Body() body: GrantDto,
  ): Promise<GrantView> {
    return this.groups.updateGrant(tenantId, caller, groupId, grantId, body);
  }

  @ApiEndpoint({
    summary: "Delete a grant",
    description:
      "Deleting the workspace's last grant lifts the restriction cliff (back to full access).",
    notFound: true,
  })
  @Delete(":groupId/grants/:grantId")
  @HttpCode(204)
  async removeGrant(
    @Param("id") tenantId: string,
    @CurrentPrincipal() caller: Principal,
    @Param("groupId") groupId: string,
    @Param("grantId") grantId: string,
  ): Promise<void> {
    await this.groups.removeGrant(tenantId, caller, groupId, grantId);
  }
}
