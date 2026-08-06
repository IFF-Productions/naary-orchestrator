import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { getPrisma } from "@naary/db";
import { type MembershipCache, type UserMembership } from "./membership-cache";

/** DI token for the swappable cache (in-memory today; Redis behind REDIS_URL later). */
export const MEMBERSHIP_CACHE = Symbol("MEMBERSHIP_CACHE");

/** Coalesce last-active writes: at most one UPDATE per user+workspace per this window, so the
 *  hot auth path never writes on every request. Enforced DB-side by the conditional WHERE. */
const LAST_ACTIVE_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Reads a user's workspaces + roles through the cache (design §6). The DB is the source
 * of truth; the cache is a per-user read-through with explicit invalidation on every
 * write. The guard does NOT consume this yet — a later slice moves enforcement here.
 */
@Injectable()
export class MembershipService {
  private readonly logger = new Logger(MembershipService.name);

  constructor(
    @Inject(MEMBERSHIP_CACHE) private readonly cache: MembershipCache,
  ) {}

  /**
   * The user's LIVE memberships (cache → DB read-through).
   *
   * DEACTIVATED ROWS ARE FILTERED OUT HERE (#1115), and this method is the chokepoint the
   * whole soft-de-provision design leans on: the AuthGuard resolves the active workspace and
   * the user's role from exactly this list, so a `Membership` with `active: false` grants
   * nothing. Filtering here rather than at each call site is what makes a future consumer
   * safe by default — a caller that forgets `active` gets the live set anyway.
   *
   * The CACHE holds the raw rows, deactivated ones included, so {@link deactivatedTenantIds}
   * can answer from the same entry without a second query (see UserMembership.active).
   */
  async listForUser(userId: string): Promise<UserMembership[]> {
    return (await this.rawForUser(userId)).filter((m) => m.active);
  }

  /**
   * The workspaces where this user holds a DEACTIVATED membership (#1115).
   *
   * Exists for exactly one caller — the AuthGuard's legacy `tenant` claim. That claim is a
   * transitional OWNER grant that needs no Membership row at all, so filtering the deactivated
   * row out of {@link listForUser} would leave the claim silently re-granting the access the
   * de-provision just took away. An explicit deactivated row therefore BEATS the claim: the
   * fail-closed reading, and the only one that lets us tell an IdP the truth.
   *
   * Answered from the same cached entry as `listForUser` — no extra hot-path query.
   */
  async deactivatedTenantIds(userId: string): Promise<Set<string>> {
    const raw = await this.rawForUser(userId);
    return new Set(raw.filter((m) => !m.active).map((m) => m.tenantId));
  }

  /** Cache → DB read-through, UNFILTERED. Private: everything outside this file wants either
   *  the live set or the deactivated ids, and a raw accessor is how "row exists ⇒ authority"
   *  creeps back in. */
  private async rawForUser(userId: string): Promise<UserMembership[]> {
    const cached = this.cache.get(userId);
    if (cached) return cached;
    const rows = await getPrisma().membership.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: { tenantId: true, role: true, active: true },
    });
    this.cache.set(userId, rows);
    return rows;
  }

  /**
   * The membership for an email address IN ONE WORKSPACE (SAML SSO linking, #455).
   *
   * Scoped to `tenantId` BY DESIGN, and there is deliberately no email-only variant: a
   * federated login must only ever link inside the tenant that owns the IdP that asserted it
   * (SAML-SSO.md "THE SECURITY INVARIANT"). Case-insensitive because `Membership.email` records
   * whatever case the user joined with, while an IdP may assert another.
   *
   * NOT cached: this is a login-time lookup, not a hot path, and a stale negative would make a
   * returning federated user look like a new one (a duplicate identity).
   *
   * IT STILL FINDS DEACTIVATED ROWS (#1115), and reports them via `active` rather than hiding
   * them. Filtering them out here would be the more obvious change and would open a hole: the
   * caller (`SsoService.resolveUser`) reads "no membership" as permission to AUTO-PROVISION,
   * so a deactivated user signing in through SAML would get a brand-new ACTIVE membership under
   * the synthetic `sso:` uid — a de-provisioned person restoring their own access by logging
   * in. The caller must be able to tell "never a member" from "deactivated"; it refuses the
   * latter.
   */
  async findByEmail(
    tenantId: string,
    email: string,
  ): Promise<{ userId: string; role: string; active: boolean } | null> {
    const trimmed = email.trim();
    if (trimmed.length === 0) return null;
    const row = await getPrisma().membership.findFirst({
      where: { tenantId, email: { equals: trimmed, mode: "insensitive" } },
      orderBy: { createdAt: "asc" },
      select: { userId: true, role: true, active: true },
    });
    return row ?? null;
  }

  /**
   * Record that this user just made an authenticated request in this workspace (#489, the
   * Team screen's "Last active"). Fire-and-forget from the guard — NEVER await it on the hot
   * path, and it must never affect authz.
   *
   * DB-side throttled: the conditional WHERE writes only when the stored value is NULL or older
   * than {@link LAST_ACTIVE_THROTTLE_MS}, so a burst of requests coalesces to one UPDATE per
   * window (no read-then-write, no per-request write). `updateMany` because we key by the
   * (userId, tenantId) unique pair without needing the row id; a zero-row result is normal.
   */
  async touchLastActive(userId: string, tenantId: string): Promise<void> {
    const staleBefore = new Date(Date.now() - LAST_ACTIVE_THROTTLE_MS);
    await getPrisma().membership.updateMany({
      where: {
        userId,
        tenantId,
        OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: staleBefore } }],
      },
      data: { lastActiveAt: new Date() },
    });
  }

  /**
   * Idempotently ensure a Membership exists for (userId, tenantId). Used to lazily
   * backfill existing claim-provisioned users into the new model on first read — a
   * purely ADDITIVE write (it records access the user already has via their claim;
   * enforcement is unchanged). Invalidates the cache so the new row is seen at once.
   *
   * `update: {}` IS LOAD-BEARING SINCE #1115, not just role preservation: this runs on the
   * guard's hot path and on every SAML auto-provision, so an `update` that touched `active`
   * would REACTIVATE a de-provisioned member the moment they tried to sign in. A new row is
   * active (the column default) because it records access the caller has already proven;
   * an existing row is left exactly as it is.
   */
  async ensureMembership(
    userId: string,
    tenantId: string,
    role: string,
    email?: string,
  ): Promise<void> {
    await getPrisma().membership.upsert({
      where: { userId_tenantId: { userId, tenantId } },
      create: { userId, tenantId, role, email: email ?? null },
      update: {}, // keep the existing role if already present
    });
    this.cache.invalidate(userId);
  }

  /**
   * Accept-on-login (design RBAC-GROUPS.md §5, slice U1): convert pending `Invitation`s
   * matching the caller's VERIFIED email into real Memberships. Called by the AuthGuard
   * beside the claim→Membership backfill — same posture: NON-authorizing (it only converts
   * invitations; access still resolves from the Membership table), and the guard swallows +
   * logs any error so a DB hiccup never 500s an authenticated user.
   *
   * Gated on a membership-cache MISS so the hot path (cached principal) stays a zero-DB
   * check: acceptance runs on login / after any invalidation / at TTL expiry — an invited
   * user's first request converts their invitation before the membership read below, so the
   * workspace appears on that very response. Worst case for an already-active session is
   * one cache TTL (~60s) before a new invitation is picked up.
   *
   * The caller MUST pre-check `emailVerified === true` — an unverified account must never
   * claim an invited address (the guard enforces this; asserted again here as defense).
   */
  async acceptPendingInvitations(
    userId: string,
    email: string,
    emailVerified: boolean,
    /**
     * Restrict conversion to ONE workspace's invitations (#455). Passed by the guard for a
     * SAML SSO session: that email was asserted by one workspace's IdP, which is authority
     * only within that workspace — converting invitations instance-wide on that basis would
     * let a workspace's own IdP claim any invited address anywhere. Undefined (Firebase, whose
     * verified email proves mailbox ownership) keeps the instance-wide behaviour.
     */
    onlyTenantId?: string,
  ): Promise<void> {
    if (!emailVerified || !email) return;
    if (this.cache.get(userId)) return; // hot path: cached principal, no invitation scan
    const prisma = getPrisma();
    const pending = await prisma.invitation.findMany({
      // Stored lowercased, but match case-insensitively (seeded/legacy rows may vary).
      where: {
        email: { equals: email, mode: "insensitive" },
        acceptedAt: null,
        ...(onlyTenantId ? { tenantId: onlyTenantId } : {}),
      },
    });
    if (pending.length === 0) return;
    for (const inv of pending) {
      // upsert with an empty update: if a Membership already exists its role WINS — an
      // invitation never re-roles an existing member (silent escalation), and the P2002
      // race (parallel first-login requests) is absorbed. Since #1115 it also means an
      // invitation can never REACTIVATE a de-provisioned membership: `active` is untouched on
      // an existing row, so accepting a stale invitation converts nothing into access. (The
      // SCIM deactivate path revokes the pending invitation anyway — this is the second belt.)
      await prisma.membership.upsert({
        where: { userId_tenantId: { userId, tenantId: inv.tenantId } },
        create: { userId, tenantId: inv.tenantId, role: inv.role, email },
        update: {},
      });
      // G1 (RBAC-GROUPS.md §3/§5): join the invitation's PermissionGroups on accept.
      // Swallow-and-log — a group-join hiccup must not abort the membership conversion
      // (access resolves from the Membership table; the group only shapes grants). Only
      // groups that actually belong to the invitation's tenant are joined (a stale or
      // cross-tenant id in the Json list is silently dropped). skipDuplicates absorbs a
      // parallel first-login race. Cold-cache note: the invitee's effective permissions
      // haven't been resolved yet at this point (first login), so no permissions-cache
      // invalidation is needed here; the short TTL covers the already-active-session edge.
      const groupIds = Array.isArray(inv.groupIds)
        ? inv.groupIds.filter((g): g is string => typeof g === "string")
        : [];
      if (groupIds.length > 0) {
        try {
          const owned = await prisma.permissionGroup.findMany({
            where: { id: { in: groupIds }, tenantId: inv.tenantId },
            select: { id: true },
          });
          if (owned.length > 0) {
            await prisma.groupMember.createMany({
              // `tenantId` completes the composite FK to the Membership upserted just above
              // (#1041) — these groups were filtered to inv.tenantId, so it is theirs.
              data: owned.map((g) => ({
                groupId: g.id,
                userId,
                tenantId: inv.tenantId,
              })),
              skipDuplicates: true,
            });
          }
        } catch (err) {
          this.logger.warn(
            `invitation group-join failed for user=${userId} tenant=${inv.tenantId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      await prisma.invitation.update({
        where: { id: inv.id },
        data: { acceptedAt: new Date() },
      });
    }
    this.cache.invalidate(userId); // new workspace visible on the very next read
  }

  /**
   * Create a brand-new workspace owned by the caller (design Path A). The `tenantId` is
   * SERVER-GENERATED (never from the request body — attack #2), so a user can neither pick
   * nor collide with an existing tenant. The caller becomes its owner. Invalidates the
   * cache so the new workspace appears immediately (e.g. in the switcher).
   */
  async createWorkspace(
    userId: string,
    email?: string,
    name?: string,
  ): Promise<UserMembership & { name?: string }> {
    const tenantId = `ws-${randomUUID()}`;
    await getPrisma().membership.create({
      data: { userId, tenantId, role: "owner", email: email ?? null },
    });
    // The workspace name is TenantSettings.displayName (same field the Settings screen
    // edits) — seed it so the switcher shows the chosen name from the first render.
    const displayName = name?.trim();
    if (displayName) {
      await getPrisma().tenantSettings.upsert({
        where: { tenantId },
        create: { tenantId, displayName },
        update: { displayName },
      });
    }
    this.cache.invalidate(userId);
    // A workspace you just created is live by construction (`Membership.active` defaults true).
    return {
      tenantId,
      role: "owner",
      active: true,
      name: displayName || undefined,
    };
  }

  /**
   * Fill in a workspace's display name ONLY if it doesn't have one yet — never overwrites
   * a name the user set in Settings. Used to lazily seed a personal default (e.g.
   * "Hassan's workspace") for legacy claim-provisioned tenants that would otherwise show
   * their raw id in the switcher. Idempotent and race-tolerant: concurrent first-login
   * requests seed the same value.
   */
  async seedWorkspaceName(tenantId: string, name: string): Promise<void> {
    const displayName = name.trim();
    if (!displayName) return;
    const prisma = getPrisma();
    // Create the settings row if absent (update: {} keeps an existing name untouched)…
    await prisma.tenantSettings.upsert({
      where: { tenantId },
      create: { tenantId, displayName },
      update: {},
    });
    // …and fill the name on a pre-existing row that has none (null/empty).
    await prisma.tenantSettings.updateMany({
      where: { tenantId, OR: [{ displayName: null }, { displayName: "" }] },
      data: { displayName },
    });
  }

  /**
   * Per-workspace metadata for /me/workspaces, in ONE batched TenantSettings read (no
   * per-workspace query): `names` maps tenantId → display name (only ids with a non-empty
   * name appear); `archived` holds the soft-archived ids (COMPANIES.md Slice 4 — archived
   * workspaces stay IN the list, flagged, so the SPA can de-prioritize without stranding a
   * user whose only workspace is archived).
   */
  async workspaceMeta(
    tenantIds: string[],
  ): Promise<{ names: Map<string, string>; archived: Set<string> }> {
    const names = new Map<string, string>();
    const archived = new Set<string>();
    if (tenantIds.length === 0) return { names, archived };
    const rows = await getPrisma().tenantSettings.findMany({
      where: { tenantId: { in: tenantIds } },
      select: { tenantId: true, displayName: true, archivedAt: true },
    });
    for (const r of rows) {
      if (r.displayName) names.set(r.tenantId, r.displayName);
      if (r.archivedAt) archived.add(r.tenantId);
    }
    return { names, archived };
  }

  /** Drop the user's cached memberships (call after any membership/role write). */
  invalidate(userId: string): void {
    this.cache.invalidate(userId);
  }
}
