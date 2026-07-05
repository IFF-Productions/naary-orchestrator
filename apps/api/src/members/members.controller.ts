import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  UseGuards,
} from "@nestjs/common";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import {
  type TenantMember,
  MembershipService,
} from "../membership/membership.service";

/**
 * Manage a workspace's members — the authoritative Membership rows (design §6/§7). tenantId
 * comes from the path (AuthGuard has verified the caller is a member of it); admin+ via the
 * controller-scoped RolesGuard. Adding a member is now an INVITE (POST /tenants/:id/
 * invitations), so there's no direct-add here — a directory row wouldn't grant access.
 */
@Controller("tenants/:id/members")
@UseGuards(RolesGuard)
@Roles("admin")
export class MembersController {
  constructor(private readonly memberships: MembershipService) {}

  @Get()
  list(@Param("id") tenantId: string): Promise<TenantMember[]> {
    return this.memberships.listForTenant(tenantId);
  }

  /** Remove a member → deletes the Membership and busts their cache (access revoked at once). */
  @Delete(":memberId")
  @HttpCode(204)
  async remove(
    @Param("id") tenantId: string,
    @Param("memberId") memberId: string,
  ): Promise<void> {
    await this.memberships.removeMembership(tenantId, memberId);
  }
}
