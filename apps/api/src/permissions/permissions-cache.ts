/**
 * Short-TTL caches for the effective-permissions layer (RBAC-GROUPS.md §4), modeled on
 * membership-cache.ts: the DB is the source of truth; every group/grant/member/token-member
 * WRITE calls `invalidateTenant` so a revocation is immediate; the TTL is a backstop.
 *
 * Two keyed spaces, both scoped by tenant so one invalidation drops everything the tenant's
 * admins just changed:
 *  - `enforced`: tenantId → "does the tenant have ≥1 WorkflowGrant?" (THE restriction switch —
 *    checked by the AuthGuard per `nry_` request and by every permission resolution, so it must
 *    not cost a query on the hot path).
 *  - `grants`: `${tenantId}|u:<uid>` / `${tenantId}|t:<tokenId>` → the subject's effective
 *    grant rows (union across their groups).
 *
 * In-memory today (single API instance); a Redis impl slots in behind the same interface.
 */

/** One effective grant row, flattened for matching (keys inlined from WorkflowGrantKey). */
export interface EffectiveGrant {
  /** null = every environment; otherwise the one env this grant applies to (§8.5). */
  environmentId: string | null;
  scope: "all" | "selected";
  canView: boolean;
  canRun: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canShare: boolean;
  canCreate: boolean;
  /** workflowKeys for scope='selected'; empty for scope='all'. */
  keys: string[];
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class PermissionsCache {
  private readonly enforced = new Map<string, Entry<boolean>>();
  private readonly grants = new Map<string, Entry<EffectiveGrant[]>>();

  constructor(
    private readonly ttlMs = 30_000,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  getEnforced(tenantId: string): boolean | undefined {
    return this.read(this.enforced, tenantId);
  }

  setEnforced(tenantId: string, value: boolean): void {
    this.write(this.enforced, tenantId, value);
  }

  getGrants(
    tenantId: string,
    subjectKey: string,
  ): EffectiveGrant[] | undefined {
    return this.read(this.grants, `${tenantId}|${subjectKey}`);
  }

  setGrants(
    tenantId: string,
    subjectKey: string,
    value: EffectiveGrant[],
  ): void {
    this.write(this.grants, `${tenantId}|${subjectKey}`, value);
  }

  /** Drop EVERYTHING cached for a tenant — called on every group/grant/member/token write so
   *  a permission change (especially a revocation) is visible on the very next request. */
  invalidateTenant(tenantId: string): void {
    this.enforced.delete(tenantId);
    const prefix = `${tenantId}|`;
    for (const key of this.grants.keys()) {
      if (key.startsWith(prefix)) this.grants.delete(key);
    }
  }

  private read<T>(store: Map<string, Entry<T>>, key: string): T | undefined {
    const hit = store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  private write<T>(store: Map<string, Entry<T>>, key: string, value: T): void {
    // Bounded: drop the oldest-inserted entry when full (Map preserves insert order).
    if (store.size >= this.maxEntries && !store.has(key)) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
    store.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
}
