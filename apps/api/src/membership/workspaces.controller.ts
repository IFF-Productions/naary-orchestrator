import { Controller, Get } from "@nestjs/common";
import { CurrentPrincipal, type Principal } from "../auth/tenant.decorator";
import { MembershipService } from "./membership.service";

export interface WorkspaceView {
  tenantId: string;
  role: string;
}

/**
 * The caller's workspaces — powers the workspace switcher (design §7). Read-only.
 *
 * Backward-compat: existing users are authenticated by the `tenant` claim / API token
 * (principal.tenantId) and may have no Membership row yet. On read we lazily backfill an
 * OWNER membership for their current tenant, so the switcher shows their workspace and
 * the new model gets seeded — additive only; the guard still enforces via the claim.
 */
@Controller("me/workspaces")
export class WorkspacesController {
  constructor(private readonly memberships: MembershipService) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
  ): Promise<WorkspaceView[]> {
    const userId = principal.subject;
    // API-token principals have no user identity (no subject) — return the token's
    // single workspace synthesized, without persisting a Membership.
    if (!userId) {
      return [{ tenantId: principal.tenantId, role: "owner" }];
    }
    let memberships = await this.memberships.listForUser(userId);
    if (memberships.length === 0 && principal.tenantId) {
      // First login of a claim-provisioned user → seed their owner membership.
      await this.memberships.ensureMembership(userId, principal.tenantId, "owner");
      memberships = await this.memberships.listForUser(userId);
    }
    return memberships.map((m) => ({ tenantId: m.tenantId, role: m.role }));
  }
}
