import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { getPrisma } from "@naary/db";
import { type MembershipCache, type UserMembership } from "./membership-cache";

/** DI token for the swappable cache (in-memory today; Redis behind REDIS_URL later). */
export const MEMBERSHIP_CACHE = Symbol("MEMBERSHIP_CACHE");

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

  /** The user's memberships (cache → DB read-through). */
  async listForUser(userId: string): Promise<UserMembership[]> {
    const cached = this.cache.get(userId);
    if (cached) return cached;
    const rows = await getPrisma().membership.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: { tenantId: true, role: true },
    });
    this.cache.set(userId, rows);
    return rows;
  }

  /**
   * Idempotently ensure a Membership exists for (userId, tenantId). Used to lazily
   * backfill existing claim-provisioned users into the new model on first read — a
   * purely ADDITIVE write (it records access the user already has via their claim;
   * enforcement is unchanged). Invalidates the cache so the new row is seen at once.
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
  ): Promise<void> {
    if (!emailVerified || !email) return;
    if (this.cache.get(userId)) return; // hot path: cached principal, no invitation scan
    const prisma = getPrisma();
    const pending = await prisma.invitation.findMany({
      // Stored lowercased, but match case-insensitively (seeded/legacy rows may vary).
      where: {
        email: { equals: email, mode: "insensitive" },
        acceptedAt: null,
      },
    });
    if (pending.length === 0) return;
    for (const inv of pending) {
      // upsert with an empty update: if a Membership already exists its role WINS — an
      // invitation never re-roles an existing member (silent escalation), and the P2002
      // race (parallel first-login requests) is absorbed.
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
              data: owned.map((g) => ({ groupId: g.id, userId })),
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
    return { tenantId, role: "owner", name: displayName || undefined };
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
