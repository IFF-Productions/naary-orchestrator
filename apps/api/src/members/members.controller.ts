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
import { AddMemberDto, ChangeRoleDto } from "./member.dto";
import { MemberResponse, RemoveMemberResponse } from "./member.response";
import { type MemberView, MembersService } from "./members.service";

/**
 * Workspace user management (RBAC-GROUPS.md §5, slice U1). tenantId comes from the path;
 * the global AuthGuard enforces path-tenant == principal-tenant, so a caller only reaches
 * their own workspace — and has already resolved the caller's ROLE onto the principal,
 * which the service's §4 gates check (owner|admin manage; elevated grants are owner-only).
 */
@ApiBearerAuth("bearer")
@Controller("tenants/:id/members")
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @ApiEndpoint({
    summary: "List workspace members and pending invitations",
    description:
      "Active memberships ∪ pending invitations; `status` discriminates ('active' | 'invited').",
    ok: [MemberResponse],
  })
  @Get()
  list(@Param("id") tenantId: string): Promise<MemberView[]> {
    return this.members.list(tenantId);
  }

  @ApiEndpoint({
    summary: "Invite a member",
    description:
      "Creates a pending INVITATION (not a membership) — the invitee joins when they sign " +
      "in with this email verified. 409 if already a member or already invited. Requires " +
      "owner/admin; only the owner may invite as admin/owner.",
    created: MemberResponse,
  })
  @Post()
  invite(
    @Param("id") tenantId: string,
    @CurrentPrincipal() caller: Principal,
    @Body() body: AddMemberDto,
  ): Promise<MemberView> {
    return this.members.invite(
      tenantId,
      caller,
      body.email,
      body.role ?? "member",
    );
  }

  @ApiEndpoint({
    summary: "Change a member's role",
    description:
      "By Firebase uid. Requires owner/admin; involving admin/owner is owner-only; the " +
      "last owner cannot be demoted (409).",
    ok: MemberResponse,
  })
  @Patch(":userId")
  changeRole(
    @Param("id") tenantId: string,
    @CurrentPrincipal() caller: Principal,
    @Param("userId") userId: string,
    @Body() body: ChangeRoleDto,
  ): Promise<MemberView> {
    return this.members.changeRole(tenantId, caller, userId, body.role);
  }

  @ApiEndpoint({
    summary: "Revoke a pending invitation",
    description:
      "By invitation id (204; no-op if unknown or already accepted). Requires owner/admin; " +
      "revoking an admin/owner invitation is owner-only.",
  })
  @Delete("invitations/:invitationId")
  @HttpCode(204)
  async revokeInvitation(
    @Param("id") tenantId: string,
    @CurrentPrincipal() caller: Principal,
    @Param("invitationId") invitationId: string,
  ): Promise<void> {
    await this.members.revokeInvitation(tenantId, caller, invitationId);
  }

  @ApiEndpoint({
    summary: "Remove a member",
    description:
      "By Firebase uid (200; `removed: false` if the uid held no membership here). Requires " +
      "owner/admin; removing an admin/owner is owner-only; the last owner cannot be removed " +
      "(409).\n\nThe removal ALWAYS commits before the body is assembled. " +
      "`strandedApprovals` then reports the paused runs whose frozen approver snapshot named " +
      "this person (#1053) — the removal is never blocked, delayed into failure, or " +
      "auto-decided on their behalf.",
    ok: RemoveMemberResponse,
  })
  @Delete(":userId")
  async remove(
    @Param("id") tenantId: string,
    @CurrentPrincipal() caller: Principal,
    @Param("userId") userId: string,
  ): Promise<RemoveMemberResponse> {
    return this.members.removeMember(tenantId, caller, userId);
  }
}
