import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
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
   * Map tenantId → workspace display name (TenantSettings.displayName) for the given ids.
   * Only ids with a non-empty name appear in the result. Used to enrich /me/workspaces so the
   * switcher shows the real name instead of an id-derived stub.
   */
  async workspaceNames(tenantIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (tenantIds.length === 0) return out;
    const rows = await getPrisma().tenantSettings.findMany({
      where: { tenantId: { in: tenantIds } },
      select: { tenantId: true, displayName: true },
    });
    for (const r of rows) if (r.displayName) out.set(r.tenantId, r.displayName);
    return out;
  }

  /** Drop the user's cached memberships (call after any membership/role write). */
  invalidate(userId: string): void {
    this.cache.invalidate(userId);
  }
}
