import { randomUUID } from "node:crypto";
import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";
import { type MembershipCache, type UserMembership } from "./membership-cache";

/** DI token for the swappable cache (in-memory today; Redis behind REDIS_URL later). */
export const MEMBERSHIP_CACHE = Symbol("MEMBERSHIP_CACHE");

/** A member of a workspace, for the Team directory (design §6). */
export interface TenantMember {
  id: string;
  userId: string;
  email: string | null;
  role: string;
  createdAt: string;
}

/**
 * The authority for workspace access + roles (design §6). The DB is the source of truth;
 * a per-user cache is a read-through with explicit invalidation on every write, so the
 * AuthGuard resolves (userId, tenant) → role per request and revocation is immediate.
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
  ): Promise<UserMembership> {
    const tenantId = `ws-${randomUUID()}`;
    await getPrisma().membership.create({
      data: { userId, tenantId, role: "owner", email: email ?? null },
    });
    this.cache.invalidate(userId);
    return { tenantId, role: "owner" };
  }

  /** All members of a workspace (the Team directory). */
  async listForTenant(tenantId: string): Promise<TenantMember[]> {
    const rows = await getPrisma().membership.findMany({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        userId: true,
        email: true,
        role: true,
        createdAt: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      email: r.email,
      role: r.role,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Remove a member from a workspace and **bust their cache** so access is revoked on the
   * very next request (attack #5 — no token-lifetime window). Looked up by (id, tenantId),
   * so an id from another tenant is a no-op, never a cross-tenant delete. Owners can't be
   * removed here (that's transfer-ownership); this also protects a claim-holder, whose own
   * claim tenant would otherwise just re-backfill on their next request.
   */
  async removeMembership(
    tenantId: string,
    membershipId: string,
  ): Promise<void> {
    const row = await getPrisma().membership.findFirst({
      where: { id: membershipId, tenantId },
      select: { id: true, userId: true, role: true },
    });
    if (!row) return; // not found / cross-tenant → no-op
    if (row.role === "owner") {
      throw new ForbiddenException("An owner can't be removed.");
    }
    await getPrisma().membership.delete({ where: { id: row.id } });
    this.cache.invalidate(row.userId);
  }

  /** Drop the user's cached memberships (call after any membership/role write). */
  invalidate(userId: string): void {
    this.cache.invalidate(userId);
  }
}
