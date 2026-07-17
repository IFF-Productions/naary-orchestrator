import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { CurrentPrincipal, type Principal } from "../auth/tenant.decorator";
import { UserScoped } from "../auth/user-scoped.decorator";
import { ApiEndpoint } from "../swagger/api-decorators";
import { MembershipService } from "./membership.service";
import { WorkspaceViewResponse } from "./workspace.response";

export interface WorkspaceView {
  tenantId: string;
  role: string;
  /** The workspace's display name (TenantSettings.displayName), if set. */
  name?: string;
}

/**
 * The personal default for an unnamed workspace: "<user name>'s workspace", falling back
 * to the email local-part ("hassan@acme.com" → "hassan's workspace"). Undefined when the
 * principal carries no usable identity (e.g. an API token).
 */
export function defaultWorkspaceName(principal: {
  name?: string;
  email?: string;
}): string | undefined {
  const base = principal.name?.trim() || principal.email?.split("@")[0]?.trim();
  return base ? `${base}'s workspace` : undefined;
}

/**
 * Workspace membership + self-serve creation (design §7). Both routes are `@UserScoped()`:
 * a brand-new user with no workspace yet must be able to list (empty) and create one.
 * `GET /me/workspaces` powers the switcher; `POST /workspaces` is Path A.
 */
@ApiBearerAuth("bearer")
@Controller()
export class WorkspacesController {
  constructor(private readonly memberships: MembershipService) {}

  /**
   * The caller's workspaces (switcher). Backward-compat: existing users authenticate by
   * the `tenant` claim / API token and may have no Membership row yet — on read we lazily
   * backfill an OWNER membership for their current tenant so the switcher shows it.
   */
  @ApiEndpoint({
    summary: "List the caller's workspaces",
    description: "Powers the workspace switcher (one entry per membership).",
    ok: [WorkspaceViewResponse],
  })
  @Get("me/workspaces")
  @UserScoped()
  async list(
    @CurrentPrincipal() principal: Principal,
  ): Promise<WorkspaceView[]> {
    const userId = principal.subject;
    // API-token principals have no user identity (no subject) — return the token's
    // single workspace synthesized, without persisting a Membership.
    if (!userId) {
      const names = await this.memberships.workspaceNames([principal.tenantId]);
      return [
        {
          tenantId: principal.tenantId,
          role: "owner",
          name: names.get(principal.tenantId),
        },
      ];
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
    // Enrich with the display name (TenantSettings.displayName) so the switcher shows the
    // real name the user set in Settings — not an id-derived stub.
    const names = await this.memberships.workspaceNames(
      memberships.map((m) => m.tenantId),
    );
    // Legacy claim-provisioned tenants (`t-*`, not server-minted `ws-*`) were never named,
    // so the switcher showed their raw id. Seed a personal default ("Hassan's workspace")
    // for the ones the caller OWNS — lazily, like the membership backfill above; a name
    // set in Settings always wins (seedWorkspaceName never overwrites).
    const fallback = defaultWorkspaceName(principal);
    if (fallback) {
      for (const m of memberships) {
        if (
          m.role === "owner" &&
          !names.get(m.tenantId) &&
          !m.tenantId.startsWith("ws-")
        ) {
          await this.memberships.seedWorkspaceName(m.tenantId, fallback);
          names.set(m.tenantId, fallback);
        }
      }
    }
    return memberships.map((m) => ({
      tenantId: m.tenantId,
      role: m.role,
      name: names.get(m.tenantId),
    }));
  }

  /**
   * Create a new workspace owned by the caller (design Path A). The `tenantId` is
   * SERVER-random (never from the body — attack #2). Gated on:
   *  - a signed-in USER (Firebase uid) — an `nry_` API token can't self-serve a workspace;
   *  - `email_verified === true` (attack #6) — an unverified email can't provision.
   * A user MAY own several workspaces (multi-workspace model) — no "must be tenant-less".
   */
  @ApiEndpoint({
    summary: "Create a workspace",
    description:
      "Self-serve workspace creation owned by the caller. Requires a signed-in, email-verified user.",
    created: WorkspaceViewResponse,
  })
  @Post("workspaces")
  @HttpCode(201)
  @UserScoped()
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: { name?: string },
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
    return this.memberships.createWorkspace(
      principal.userId,
      principal.email,
      body?.name,
    );
  }
}
