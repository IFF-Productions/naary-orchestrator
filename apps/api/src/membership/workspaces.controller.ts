import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
} from "@nestjs/common";
import { CurrentPrincipal, type Principal } from "../auth/tenant.decorator";
import { UserScoped } from "../auth/user-scoped.decorator";
import { MembershipService } from "./membership.service";

export interface WorkspaceView {
  tenantId: string;
  role: string;
}

/**
 * Workspace membership + self-serve creation (design §7). Both routes are `@UserScoped()`:
 * a brand-new user with no workspace yet must be able to list (empty) and create one.
 * `GET /me/workspaces` powers the switcher; `POST /workspaces` is Path A.
 */
@Controller()
export class WorkspacesController {
  constructor(private readonly memberships: MembershipService) {}

  /**
   * The caller's workspaces (switcher). Backward-compat: existing users authenticate by
   * the `tenant` claim / API token and may have no Membership row yet — on read we lazily
   * backfill an OWNER membership for their current tenant so the switcher shows it.
   */
  @Get("me/workspaces")
  @UserScoped()
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
      await this.memberships.ensureMembership(
        userId,
        principal.tenantId,
        "owner",
      );
      memberships = await this.memberships.listForUser(userId);
    }
    return memberships.map((m) => ({ tenantId: m.tenantId, role: m.role }));
  }

  /**
   * Create a new workspace owned by the caller (design Path A). The `tenantId` is
   * SERVER-random (never from the body — attack #2). Gated on:
   *  - a signed-in USER (Firebase uid) — an `nry_` API token can't self-serve a workspace;
   *  - `email_verified === true` (attack #6) — an unverified email can't provision.
   * A user MAY own several workspaces (multi-workspace model) — no "must be tenant-less".
   */
  @Post("workspaces")
  @HttpCode(201)
  @UserScoped()
  async create(
    @CurrentPrincipal() principal: Principal,
  ): Promise<WorkspaceView> {
    if (!principal.userId) {
      throw new ForbiddenException(
        "Creating a workspace requires a signed-in user account.",
      );
    }
    if (!principal.emailVerified) {
      throw new ForbiddenException(
        "Verify your email address before creating a workspace.",
      );
    }
    return this.memberships.createWorkspace(principal.userId, principal.email);
  }
}
