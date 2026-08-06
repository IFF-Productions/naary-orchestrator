import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { getPrisma } from "@naary/db";
import type { Principal } from "../auth/tenant.decorator";
import { AuditService } from "../audit/audit.service";
import { ApiTokenService } from "../auth/api-token.service";
import { CliRefreshTokenService } from "../auth/cli-refresh-token.service";
import { appBaseUrl } from "../connections/connect-return";
import {
  NO_HELD_APPROVALS,
  UNKNOWN_HELD_APPROVALS,
  type HeldApprovals,
} from "../executions/executions.approval-holds";
import { ExecutionsService } from "../executions/executions.service";
import { MailerService } from "../mail/mailer.service";
import { MembershipService } from "../membership/membership.service";
import { PermissionsService } from "../permissions/permissions.service";

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
  /**
   * Is this member's access live? (#1115.) `false` = their `Membership` is DEACTIVATED — the
   * row, its role and its permission groups are all intact, but the AuthGuard denies them.
   * Absent on invited rows (no membership to switch off).
   *
   * A NEW FIELD RATHER THAN A THIRD `status` VALUE, deliberately: the Team screen partitions
   * on `status === "active" | "invited"`, so a third value would make deactivated members
   * vanish from the screen entirely — the opposite of the legibility this exists for. An
   * admin has to be able to SEE that the person is switched off, because workspace-side
   * removal is the documented escape hatch when the IdP cannot de-provision them.
   */
  active?: boolean;
  createdAt: string;
  /** Last authenticated request in this workspace (#489). Active rows only; null = not seen
   *  since the column was added. Absent on invited rows (they have no membership yet). */
  lastActiveAt?: string | null;
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
  private readonly logger = new Logger(MembersService.name);

  constructor(
    private readonly memberships: MembershipService,
    private readonly mailer: MailerService,
    private readonly permissions: PermissionsService,
    /** #1053 — the only holder of the Temporal client, for the post-removal approval read. */
    private readonly executions: ExecutionsService,
    /** #1053 — the path-INDEPENDENT surface (see {@link removeMember}). */
    private readonly audit: AuditService,
    /** #1117 — offboarding must kill the user's CLI rotation families (see
     *  {@link revokeCliSessions}). From the @Global AuthModule. */
    private readonly cliSessions: CliRefreshTokenService,
    /** …and the LIVE access token those families already minted (#1118's documented residual).
     *  Same module, same method — see {@link revokeCliSessions}. */
    private readonly apiTokens: ApiTokenService,
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
      // A DEACTIVATED member is still a member (#1115) — the row, its role and its groups all
      // survive — so this stays a 409 rather than quietly re-inviting them, which would create
      // an Invitation that accept-on-login could not honour anyway (the upsert there leaves
      // `active` alone). The message names the state because otherwise an admin re-inviting
      // someone their IdP switched off gets "already a member" for a person the screen shows
      // as unable to sign in, and the real remedy — reactivate in the directory, or remove
      // them here and start over — is invisible.
      throw new ConflictException(
        existingMember.active === false
          ? "That email belongs to a DEACTIVATED member of this workspace. Reactivate them in your directory, or remove them here first."
          : "That email already belongs to a member of this workspace.",
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
   *
   * A DEMOTION ALSO KILLS THE TARGET'S CLI SESSIONS (#1117), and that is not belt-and-braces:
   * a CLI access token is an `nry_` `ApiToken` row, and `AuthGuard`'s `nry_` branch resolves the
   * principal from the TOKEN — tenant from the token row, `role: "owner"` stamped, no `userId`,
   * no `Membership` read anywhere (auth.guard.ts, the `token.startsWith("nry_")` branch). So a
   * CLI session's authority is NOT re-derived per request from current membership the way a
   * Firebase/SSO session's is; demoting an owner leaves their CLI minting owner-stamped tokens
   * off a refresh family that never looks at the role. Nothing else in this method would notice.
   *
   * The predicate is A REAL CHANGE INTO a role outside the {@link ELEVATED} set that gates who
   * may hold an elevated role — the same set `CliAuthController.assertMayApprove` enforces — so
   * it reads as "you no longer qualify to hold a CLI session, so you don't hold one."
   *  - owner→admin is deliberately NOT a revocation: an admin may approve a CLI login and that
   *    token already stamps owner, so there is no authority they could not re-obtain in one
   *    command.
   *  - `previousRole !== role` is what keeps a NO-OP write from being a revocation. Re-saving an
   *    unchanged `member` would otherwise sign that member out of a CLI session they legitimately
   *    hold — a restricted-token workspace stamps `member`, and a family can outlive a demotion
   *    whose revoke failed non-fatally. Retrying such a failure means re-applying the DEMOTION,
   *    which still matches this predicate; it does not mean re-saving any role at all.
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
    // Captured BEFORE the update: the demotion check below runs after it, and "what were they
    // before?" must not be re-read from a row the write may have moved on.
    const previousRole = target.role;
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
    // …and the PERMISSIONS cache too (#1041). A role change crosses the RBAC-GROUPS §4
    // bypass line in BOTH directions — member→admin makes the subject bypass grants,
    // admin→member makes it gated — and the permissions cache keys per subject, so a
    // stale entry outlives the role change either way.
    this.permissions.invalidateTenant(tenantId);
    // …and, on a demotion, the CLI — which does NOT re-read the role per request (see the
    // docstring). Non-fatal and last, for the same reasons as in `removeMember`: the role change
    // has committed and must not be reported as failed, and the two in-memory invalidations are
    // free while this is a DB round-trip.
    if (previousRole !== role && !ELEVATED.has(role)) {
      await this.revokeCliSessions(tenantId, caller, userId, "demoted");
    }
    return activeView(row);
  }

  /**
   * Remove an active member (by Firebase uid). Owner|admin; removing an admin/owner is
   * owner-only; the last owner cannot be removed (409). Unknown uid → no-op (204), never
   * a cross-tenant delete.
   *
   * Removal takes the user's PERMISSION-GROUP rows with it (#1041). This used to delete the
   * `Membership` alone, and `GroupMember.userId` was a bare string with no FK — so the group
   * rows survived, invisible and inert (AuthGuard fails closed without a Membership), until
   * the user was RE-INVITED, at which point they silently regained every group they had been
   * in. Nobody granted it and nothing surfaced it.
   *
   * The durable fix is the composite FK `GroupMember(userId, tenantId) → Membership` with
   * ON DELETE CASCADE, so this holds for every path that ever deletes a membership. This
   * explicit delete is its EXPAND-WINDOW bridge: the FK's `tenantId` column is still nullable
   * (see the migration's expand/contract note), and a NULL-tenantId row — what an old image
   * writes mid-rollout — is exempt from the FK under MATCH SIMPLE. After the contract
   * migration this becomes redundant defense in depth, which is where it should stay.
   *
   * TENANT-SCOPED through the group relation: `{ userId }` alone would wipe the user's groups
   * in EVERY workspace. One transaction, so a membership can never be deleted without its
   * group rows going too.
   *
   * ---
   *
   * STRANDED APPROVALS (#1053). Removing someone does not touch the paused runs that named
   * them as approver: a `humanApproval` gate froze its approver list into `ctx.__approval` at
   * pause time. So the removal can silently leave a compliance gate with nobody able to
   * decide it — and with no `timeoutHours`, parked forever. We report it; we NEVER auto-decide
   * it. Auto-rejecting on removal would make a run report a decision no human made, on a gate
   * whose entire purpose is that a human made it.
   *
   * REPORT AFTER, never gate. The removal commits FIRST and the report is assembled from what
   * is left — three properties fall out of that ordering, and all three matter:
   *  - a removal can never be blocked or slowed into failure by Temporal being unreachable
   *    (de-provisioning is security-relevant; a member removal that 500s because a workflow
   *    service is down is a worse bug than the one this fixes);
   *  - "is anyone left to approve?" is answered against the state the admin is actually in;
   *  - it is honest on the SCIM/directory-sync path. A pre-flight confirmation only helps a
   *    human at a keyboard; an automated de-provisioner would either always confirm (making
   *    the warning dead code) or always fail (breaking de-provisioning). Nothing is lost by
   *    reporting after, because the resolution — an owner/admin decision, or the HMAC signed
   *    link — works identically before and after the removal.
   *
   * Two surfaces, because the response body alone is not one a directory-sync connector reads:
   * the returned {@link HeldApprovals} (which the Team screen shows), and an AuditEvent, which
   * is the workspace-visible record every removal path lands in, human-driven or not.
   *
   * The group ids are read BEFORE the delete on purpose — the `GroupMember` rows are gone
   * afterwards, and a group-routed gate can only be matched by id.
   */
  async removeMember(
    tenantId: string,
    caller: Principal,
    userId: string,
  ): Promise<{ removed: boolean; strandedApprovals: HeldApprovals }> {
    assertManager(caller);
    const prisma = getPrisma();
    const target = await prisma.membership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
    });
    // unknown/foreign uid — no-op, not a 500. Nothing was removed, so nothing was stranded.
    if (!target)
      return { removed: false, strandedApprovals: NO_HELD_APPROVALS };
    assertOwnerForElevated(caller, target.role);
    if (target.role === "owner") {
      await this.assertNotLastOwner(tenantId, "removed");
    }
    // Their approver identity, captured while it still exists (see the docstring).
    const groupIds = (
      await prisma.groupMember.findMany({
        where: { userId, group: { tenantId } },
        select: { groupId: true },
      })
    ).map((g) => g.groupId);
    await prisma.$transaction([
      prisma.groupMember.deleteMany({
        where: { userId, group: { tenantId } },
      }),
      prisma.membership.deleteMany({ where: { tenantId, userId } }),
    ]);
    this.memberships.invalidate(userId); // revocation is immediate
    // The removed user's cached EffectiveGrant[] must not outlive them (#1041): the
    // permissions cache is per-subject with a 30s TTL and, per permissions-cache.ts, is
    // slated to become a SHARED (Redis) cache — so the TTL tail is a real multi-instance
    // window, not a single-process nicety. Tenant-wide because a removal also changes what
    // the group's REMAINING subjects resolve to.
    this.permissions.invalidateTenant(tenantId);
    // …and their CLI session — both halves (#1117 + #1118's residual). A `CliRefreshToken` is
    // keyed to a userId with a 90-day absolute cap, so it OUTLIVED the Membership just deleted: a
    // removed user kept rotating for up to a quarter, collecting a fresh 12h owner-stamped `nry_`
    // token each time, which is precisely what "revocation is immediate" above claimed did not
    // happen. The `nry_` token already in their hand is deleted too, now that `ApiToken.userId`
    // says whose it is. The two in-memory invalidations run first because they are synchronous and
    // free; this one is a DB round-trip and no cache depends on it.
    await this.revokeCliSessions(tenantId, caller, userId, "removed");

    // Everything past this point is REPORTING. The removal has committed; findHeldApprovals
    // is documented never to throw, and this catch is the second belt on that promise —
    // an unreported stranding must never surface as a failed removal.
    let strandedApprovals: HeldApprovals;
    try {
      strandedApprovals = await this.executions.heldApprovals(tenantId, {
        email: target.email,
        groupIds,
      });
    } catch {
      strandedApprovals = UNKNOWN_HELD_APPROVALS;
    }
    this.recordStranded(tenantId, caller, userId, "removed", strandedApprovals);
    return { removed: true, strandedApprovals };
  }

  /**
   * SOFT DE-PROVISION / RE-PROVISION (#1115 decision (b)) — flip `Membership.active`.
   *
   * THE POINT OF THE COLUMN, stated once here because every other doc in this feature refers
   * back to it: deactivation takes ACCESS away and nothing else. The `Membership` row, its
   * role and — critically — its `GroupMember` rows all survive, so `setMemberActive(…, true)`
   * later restores the PERSON AND THEIR GRANTS. Mapping SCIM's `active: false` onto
   * {@link removeMember} instead would revoke just as hard and cascade the groups away, and a
   * reactivated leaver would come back with an account that can see nothing.
   *
   * IT LIVES HERE, NOT IN THE SCIM LAYER, and that is the same rule the de-provision path
   * already follows. `removeMember`'s docstring lists four things a hand-rolled
   * `membership.deleteMany` would silently lose; deactivation needs every one of them, because
   * the user's credentials are just as live afterwards:
   *   1. `memberships.invalidate(userId)` — the guard reads a 60s per-user cache;
   *   2. `permissions.invalidateTenant(tenantId)` — their cached `EffectiveGrant[]` (30s, and
   *      slated to become a SHARED Redis cache) must not outlive their access;
   *   3. {@link revokeCliSessions} — THE ONE A COLUMN CANNOT COVER. `AuthGuard`'s `nry_`
   *      branch returns a full-access principal from the TOKEN ROW with no `Membership` read
   *      anywhere, so a deactivated user's CLI session keeps working for up to 12h and keeps
   *      minting successors for up to 90 days. Deactivating without this would be a
   *      de-provision that the person's terminal never hears about;
   *   4. the stranded-approval report + its AuditEvent — a paused compliance gate whose only
   *      approver was just switched off is exactly as stuck as if they had been deleted.
   * The role ceiling (`assertOwnerForElevated`) and the last-owner guard come with the
   * location: deactivating an admin is refused for the same reason removing one is.
   *
   * NO-OP WHEN NOTHING CHANGES (`changed: false`), so an IdP re-sending `active: false` on
   * every sync — which they do — does not re-revoke a CLI session, re-report a stranding or
   * write an audit row per poll. Same shape as `removeMember`'s `removed: false`.
   */
  async setMemberActive(
    tenantId: string,
    caller: Principal,
    userId: string,
    active: boolean,
  ): Promise<{ changed: boolean; strandedApprovals: HeldApprovals }> {
    assertManager(caller);
    const prisma = getPrisma();
    const target = await prisma.membership.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
    });
    // unknown/foreign uid — no-op, not a 500, exactly as removeMember treats one.
    if (!target)
      return { changed: false, strandedApprovals: NO_HELD_APPROVALS };
    assertOwnerForElevated(caller, target.role);
    // The last-owner guard applies to deactivation for the reason it applies to removal: an
    // owner who cannot sign in does not administer anything.
    if (!active && target.role === "owner") {
      await this.assertNotLastOwner(tenantId, "deactivated");
    }
    if (target.active === active) {
      return { changed: false, strandedApprovals: NO_HELD_APPROVALS };
    }
    // Read while they are still an approver, like removeMember does — the report below runs
    // after the write and must not count the person it just switched off.
    const groupIds = (
      await prisma.groupMember.findMany({
        where: { userId, group: { tenantId } },
        select: { groupId: true },
      })
    ).map((g) => g.groupId);

    await prisma.membership.update({
      where: { userId_tenantId: { userId, tenantId } },
      data: { active },
    });
    this.memberships.invalidate(userId); // revocation is immediate
    this.permissions.invalidateTenant(tenantId);

    if (active) {
      // Reactivation grants access back; it revokes nothing and stranded nothing. Their
      // GroupMember rows were never touched, so their grants come back with them — which is
      // the entire argument for this column over a delete.
      return { changed: true, strandedApprovals: NO_HELD_APPROVALS };
    }

    await this.revokeCliSessions(tenantId, caller, userId, "deactivated");

    // Everything past here is REPORTING — same contract as removeMember: the write has
    // committed and an unreported stranding must never surface as a failed de-provision.
    let strandedApprovals: HeldApprovals;
    try {
      strandedApprovals = await this.executions.heldApprovals(tenantId, {
        email: target.email,
        groupIds,
      });
    } catch {
      strandedApprovals = UNKNOWN_HELD_APPROVALS;
    }
    this.recordStranded(
      tenantId,
      caller,
      userId,
      "deactivated",
      strandedApprovals,
    );
    return { changed: true, strandedApprovals };
  }

  /**
   * Kill the user's CLI session in this workspace (#1117) — the offboarding half of "revocation is
   * immediate", for {@link removeMember}, a demotion in {@link changeRole}, and a deactivation
   * in {@link setMemberActive}.
   *
   * BOTH HALVES OF THE CREDENTIAL, because a CLI session is two rows:
   *  1. the rotation FAMILIES (`CliRefreshTokenService.revokeUserSessions`) — the 90-day half.
   *     Revoking it means the session can mint nothing new.
   *  2. the LIVE ACCESS TOKEN it already minted (`ApiTokenService.revokeUserCliTokens`) — the 12h
   *     half, and the residual #1118 left open with no way to close it: `ApiToken` had no owner
   *     column, so the row could not be attributed to this user and deleting by the `naary CLI`
   *     label would have signed out everyone else in the workspace. `ApiToken.userId` (written at
   *     `/auth/cli/exchange` and `/auth/cli/refresh`, NULL on every Settings/CI token) is what
   *     makes this deletion attributable.
   *
   * ORDER IS LOAD-BEARING: families FIRST. If the second call fails we have still closed the
   * 90-day window and left only a ≤12h one that cannot renew itself — the reverse ordering would
   * fail the other way round, deleting one token while the family keeps issuing replacements.
   *
   * ONE PATH EACH. It delegates rather than issuing its own writes — `revokeUserSessions` resolves
   * the user's live families and revokes each through the same `revokeFamily` reuse detection uses,
   * and `revokeUserCliTokens` owns the only read of `ApiToken.userId`. There is deliberately no
   * `cliRefreshToken.updateMany` and no `apiToken.deleteMany` in this file. Both are tenant-scoped,
   * so a consultant removed from one workspace keeps their CLI session in the others.
   *
   * NON-FATAL, DELIBERATELY, and it is the ordering that earns it. Both callers have already
   * COMMITTED their write when they get here, so throwing would report a failure for a removal
   * (or a role change) that definitely happened — and on the SCIM path that means an IdP retrying
   * a de-provision it already achieved, or worse, recording it as failed while the member really
   * is gone. A removal that half-happens is the worse bug; a live refresh family is bounded by
   * the same caps it always had. Ordering it BEFORE the delete instead would trade this for a
   * user whose CLI is signed out while they are still a member — recoverable, but it would make
   * a transient DB error block de-provisioning, which #1053 already ruled out for this method.
   *
   * A failure is therefore not swallowed quietly: it logs at ERROR **and** writes an AuditEvent,
   * because the workspace-visible record is the only surface a directory-sync caller leaves
   * behind, and "their CLI session may still work" is exactly the state someone must be able to
   * find later. The message does NOT name which half failed, because the catch cannot tell — and
   * either way the operator action is the same: re-apply the change, which re-runs both. Both
   * calls are idempotent, so a retry over an already-revoked family or an already-deleted token is
   * a no-op. The audit write is itself fire-and-forget — an audit row must never be the reason a
   * completed removal reports an error, same as {@link recordStranded}.
   */
  private async revokeCliSessions(
    tenantId: string,
    caller: Principal,
    userId: string,
    verb: "removed" | "demoted" | "deactivated",
  ): Promise<void> {
    try {
      const { families, tokens } = await this.cliSessions.revokeUserSessions(
        tenantId,
        userId,
      );
      // The 12h half. AFTER the families (see the docstring) and inside the same try, so a
      // failure here is reported and audited exactly like a failed family revoke.
      const access = await this.apiTokens.revokeUserCliTokens(tenantId, userId);
      if (families > 0 || access > 0) {
        this.logger.log(
          `Revoked ${families} CLI refresh famil${families === 1 ? "y" : "ies"} ` +
            `(${tokens} live token(s)) and deleted ${access} live CLI access token(s) ` +
            `for a ${verb} member of tenant=${tenantId}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `CLI session revocation FAILED for a ${verb} member of tenant=${tenantId}: ${message}. ` +
          `Their CLI session may still work — re-apply the change to retry.`,
      );
      void this.audit
        .record({
          tenantId,
          actor: caller.subject ?? caller.userId ?? "api-token",
          action: `A member was ${verb}, but revoking their CLI sessions failed — their CLI may keep working until it expires`,
          method: verb === "removed" ? "DELETE" : "PATCH",
          path: `/tenants/${tenantId}/members/${userId}`,
          statusCode: 200,
        })
        .catch(() => undefined);
    }
  }

  /**
   * The SCIM/no-human surface: an AuditEvent, so a removal that stranded a gate is visible on
   * the Activity screen even when the caller was a directory sync that discarded the response
   * body. The count rides in `action` because AuditEvent has no free-form field and this
   * change is not adding a column to a table another migration is mid-flight on (#1052).
   *
   * `partial` counts are a lower bound, so they are labelled `+` rather than reported as exact.
   * Fire-and-forget: `AuditService.record` already swallows, and an audit row must never be
   * the reason a completed removal reports an error.
   *
   * `verb` because a DEACTIVATION strands a gate exactly as a removal does (#1115) and the row
   * has to say which happened: an admin reading "Removed a member holding 2 paused approvals"
   * about someone still visible on the Team screen would go looking for a removal that never
   * occurred.
   */
  private recordStranded(
    tenantId: string,
    caller: Principal,
    userId: string,
    verb: "removed" | "deactivated",
    held: HeldApprovals,
  ): void {
    if (held.needsOwnerOrAdmin === 0 && !held.partial) return;
    const n = `${held.needsOwnerOrAdmin}${held.partial ? "+" : ""}`;
    const what = verb === "removed" ? "Removed" : "Deactivated";
    void this.audit
      .record({
        tenantId,
        actor: caller.subject ?? caller.userId ?? "api-token",
        action: held.partial
          ? `${what} a member; paused approvals not fully checked (${n} need an owner or admin)`
          : `${what} a member holding ${n} paused approval${held.needsOwnerOrAdmin === 1 ? "" : "s"} that now need an owner or admin`,
        method: verb === "removed" ? "DELETE" : "PATCH",
        path: `/tenants/${tenantId}/members/${userId}`,
        statusCode: 200,
      })
      .catch(() => undefined);
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

  /**
   * 409 when the tenant has a single owner left — they can be neither removed nor demoted
   * nor (since #1115) deactivated.
   *
   * ACTIVE OWNERS ONLY. A deactivated owner cannot sign in, so counting them would let one
   * live owner + one switched-off owner read as two and permit removing the live one, leaving
   * a workspace whose only owner row is one the guard refuses — unadministerable, which is the
   * exact state this guard exists to prevent.
   */
  private async assertNotLastOwner(
    tenantId: string,
    verb: "removed" | "demoted" | "deactivated",
  ): Promise<void> {
    const owners = await getPrisma().membership.count({
      where: { tenantId, role: "owner", active: true },
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
  lastActiveAt: Date | null;
  active?: boolean;
}): MemberView {
  return {
    id: r.userId,
    userId: r.userId,
    email: r.email ?? "",
    role: r.role,
    status: "active",
    // `?? true` covers the rolling-deploy read of a row written before the column existed and
    // the unit fixtures that predate it — "unknown" is "live", the same answer the NOT NULL
    // DEFAULT true gives in the database.
    active: r.active ?? true,
    createdAt: r.createdAt.toISOString(),
    lastActiveAt: r.lastActiveAt ? r.lastActiveAt.toISOString() : null,
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
