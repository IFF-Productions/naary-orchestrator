/** A user's workspaces + role (the cached authority — design §6). */
export interface UserMembership {
  tenantId: string;
  role: string;
}

/**
 * Per-user membership cache. Keyed by userId → their full membership set, so the guard
 * (a later slice) can resolve (userId, activeTenant) → role without a DB read per
 * request. Every membership/role WRITE must call invalidate(userId) so revocation is
 * immediate (design attack scenario #7). In-memory today; a Redis impl slots in behind
 * the same interface (select by REDIS_URL) for multi-instance deploys.
 */
export interface MembershipCache {
  get(userId: string): UserMembership[] | undefined;
  set(userId: string, memberships: UserMembership[]): void;
  invalidate(userId: string): void;
}

/**
 * In-memory TTL cache with a bounded size (simple LRU-by-insertion eviction). Fine for
 * a single API instance; the TTL is a backstop since writes invalidate explicitly.
 */
export class InMemoryMembershipCache implements MembershipCache {
  private readonly store = new Map<
    string,
    { value: UserMembership[]; expiresAt: number }
  >();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(userId: string): UserMembership[] | undefined {
    const hit = this.store.get(userId);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.store.delete(userId);
      return undefined;
    }
    return hit.value;
  }

  set(userId: string, memberships: UserMembership[]): void {
    // Bounded: drop the oldest-inserted entry when full (Map preserves insert order).
    if (this.store.size >= this.maxEntries && !this.store.has(userId)) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(userId, {
      value: memberships,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  invalidate(userId: string): void {
    this.store.delete(userId);
  }
}
