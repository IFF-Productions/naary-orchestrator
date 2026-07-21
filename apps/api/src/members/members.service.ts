import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { getPrisma } from "@naary/db";
import type { Principal } from "../auth/tenant.decorator";
import { appBaseUrl } from "../connections/connect-return";
import { MailerService } from "../mail/mailer.service";
import { MembershipService } from "../membership/membership.service";

/** `active` = a real Membership (uid-keyed authority); `invited` = a pending Invitation
 *  awaiting accept-on-login (RBAC-GROUPS.md §5). */
export type MemberStatus = "active" | "invited";

export interface MemberView {
  /** Firebase uid for active rows (PATCH/DELETE key); invitation id for invited rows. */
  id: string;
  /** Present on active rows only — the Membership's Firebase uid. */
  userId?: string;
  email: string;
  role: string;
  status: MemberStatus;
  createdAt: string;
}

/** Roles only the workspace OWNER may grant or revoke (design RBAC-GROUPS.md §4). */
const ELEVATED = new Set(["owner", "admin"]);

/** Member add/remove/role-change requires owner|admin (§4 role-management hardening). */
function assertManager(caller: Principal): void {
  if (caller.role !== "owner" && caller.role !== "admin") {
    throw new ForbiddenException(
      "Managing members requires the owner or admin role.",
    );
  }
}

/** Only the OWNER grants or revokes admin/owner (an admin can manage plain members). */
function assertOwnerForElevated(
  caller: Principal,
  ...roles: (string | undefined)[]
): void {
  if (
    caller.role !== "owner" &&
    roles.some((r) => r !== undefined && ELEVATED.has(r))
  ) {
    throw new ForbiddenException(
      "Only the workspace owner can grant or revoke admin/owner roles.",
    );
  }
}

/**
 * Workspace user management (design RBAC-GROUPS.md §5, slice U1). Membership-backed:
 * the list is real `Membership` rows (the authz authority the AuthGuard enforces) ∪
 * pending `Invitation`s; adding a member CREATES AN INVITATION which accept-on-login
 * converts once the invitee signs in with that (verified) email. The legacy advisory
 * `Member` table is no longer read or written (it retires in slice G3).
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly memberships: MembershipService,
    private readonly mailer: MailerService,
  ) {}

  /**
   * Best-effort invitation email (#468). Fire-and-forget: looks up the workspace name (best-effort)
   * and sends via the platform mailer, which itself no-ops when SMTP isn't configured and never
   * throws — so a mail problem can NEVER break the invite. Awaited nowhere on the request path.
   */
  private sendInviteEmail(tenantId: string, email: string): void {
    void (async () => {
      let workspaceName: string | undefined;
      try {
        const settings = await getPrisma().tenantSettings.findUnique({
          where: { tenantId },
        });
        workspaceName = settings?.displayName ?? undefined;
      } catch {
        /* name is cosmetic — fall back to a generic label */
      }
      await this.mailer.sendInvitation({
        to: email,
        workspaceName,
        // Server-derived base (never a request param) + the sign-in screen; empty base ⇒ a
        // same-origin relative path, correct in the shared-host topology.
        signInUrl: `${appBaseUrl()}/auth`,
      });
    })().catch(() => undefined);
  }

  /** Active memberships ∪ pending invitations, flat with a `status` discriminator. */
  async list(tenantId: string): Promise<MemberView[]> {
    const prisma = getPrisma();
    const [members, invitations] = await Promise.all([
      prisma.membership.findMany({
        where: { tenantId },
        orderBy: { createdAt: "asc" },
      }),
      prisma.invitation.findMany({
        where: { tenantId, acceptedAt: null },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    return [...members.map(activeView), ...invitations.map(invitedView)];
  }

  /**
   * Invite a user by email (creates a pending Invitation — NOT a Membership; the invitee
   * becomes a member when they sign in with this email VERIFIED). 409 when the email is
   * already an active member or already invited. Role gates per §4: owner|admin may
   * invite; only the owner may invite as admin/owner.
   */
  async invite(
    tenantId: string,
    caller: Principal,
    email: string,
    role: string,
  ): Promise<MemberView> {
    assertManager(caller);
    assertOwnerForElevated(caller, role);
    const prisma = getPrisma();
    const norm = email.trim().toLowerCase();
    const existingMember = await prisma.membership.findFirst({
      where: { tenantId, email: { equals: norm, mode: "insensitive" } },
    });
    if (existingMember) {
      throw new ConflictException(
        "That email already belongs to a member of this workspace.",
      );
    }
    const existing = await prisma.invitation.findUnique({
      where: { tenantId_email: { tenantId, email: norm } },
    });
    if (existing && existing.acceptedAt === null) {
      throw new ConflictException(
        "An invitation for that email is already pending.",
      );
    }
    if (existing) {
      // Previously accepted, but the membership is gone (member since removed) —
      // re-open the invitation instead of dead-ending on the unique constraint.
      const row = await prisma.invitation.update({
        where: { id: existing.id },
        data: {
          role,
          invitedBy: caller.userId ?? caller.subject ?? "api-token",
          acceptedAt: null,
          createdAt: new Date(),
        },
      });
      this.sendInviteEmail(tenantId, norm);
      return invitedView(row);
    }
    try {
      const row = await prisma.invitation.create({
        data: {
          tenantId,
          email: norm,
          role,
          invitedBy: caller.userId ?? caller.subject ?? "api-token",
        },
      });
      this.sendInviteEmail(tenantId, norm);
      return invitedView(row);
    } catch (err) {
      // P2002 = the (tenantId, email) unique hit in a race with a concurrent invite.
      if ((err as { code?: string })?.code === "P2002") {
        throw new ConflictException(
          "An invitation for that email is already pending.",
        );
      }
      throw err;
    }
  }

  /**
   * Change an active member's role. Owner|admin; involving admin/owner (either the
   * target's current role or the new one) is owner-only; the last owner cannot be
   * demoted (409).
   */
  async changeRole(
    tenantId: string,
    caller: Principal,
    userId: string,
    role: string,
  ): Promise<MemberView> {
    assertManager(caller);
    const prisma = getPrisma();
    const target = await prisma.membership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
    });
    if (!target) throw new NotFoundException("No such member.");
    assertOwnerForElevated(caller, role, target.role);
    if (target.role === "owner" && role !== "owner") {
      await this.assertNotLastOwner(tenantId, "demoted");
    }
    const row = await prisma.membership.update({
      where: { userId_tenantId: { userId, tenantId } },
      data: { role },
    });
    // Invalidate so the demoted/promoted user's next request sees the new role at once
    // (revocation must be immediate — same posture as every membership write).
    this.memberships.invalidate(userId);
    return activeView(row);
  }

  /**
   * Remove an active member (by Firebase uid). Owner|admin; removing an admin/owner is
   * owner-only; the last owner cannot be removed (409). Unknown uid → no-op (204), never
   * a cross-tenant delete.
   */
  async removeMember(
    tenantId: string,
    caller: Principal,
    userId: string,
  ): Promise<void> {
    assertManager(caller);
    const prisma = getPrisma();
    const target = await prisma.membership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
    });
    if (!target) return; // unknown/foreign uid — no-op, not a 500
    assertOwnerForElevated(caller, target.role);
    if (target.role === "owner") {
      await this.assertNotLastOwner(tenantId, "removed");
    }
    await prisma.membership.deleteMany({ where: { tenantId, userId } });
    this.memberships.invalidate(userId); // revocation is immediate
  }

  /**
   * Revoke a PENDING invitation (by invitation id). Owner|admin; revoking an admin/owner
   * invitation is owner-only. Unknown/accepted id → no-op (204).
   */
  async revokeInvitation(
    tenantId: string,
    caller: Principal,
    invitationId: string,
  ): Promise<void> {
    assertManager(caller);
    const prisma = getPrisma();
    const target = await prisma.invitation.findFirst({
      where: { id: invitationId, tenantId, acceptedAt: null },
    });
    if (!target) return; // unknown/foreign/already-accepted — no-op
    assertOwnerForElevated(caller, target.role);
    await prisma.invitation.deleteMany({
      where: { id: invitationId, tenantId, acceptedAt: null },
    });
  }

  /** 409 when the tenant has a single owner left — they can be neither removed nor demoted. */
  private async assertNotLastOwner(
    tenantId: string,
    verb: "removed" | "demoted",
  ): Promise<void> {
    const owners = await getPrisma().membership.count({
      where: { tenantId, role: "owner" },
    });
    if (owners <= 1) {
      throw new ConflictException(
        `The last owner of a workspace cannot be ${verb}.`,
      );
    }
  }
}

function activeView(r: {
  userId: string;
  email: string | null;
  role: string;
  createdAt: Date;
}): MemberView {
  return {
    id: r.userId,
    userId: r.userId,
    email: r.email ?? "",
    role: r.role,
    status: "active",
    createdAt: r.createdAt.toISOString(),
  };
}

function invitedView(r: {
  id: string;
  email: string;
  role: string;
  createdAt: Date;
}): MemberView {
  return {
    id: r.id,
    email: r.email,
    role: r.role,
    status: "invited",
    createdAt: r.createdAt.toISOString(),
  };
}
