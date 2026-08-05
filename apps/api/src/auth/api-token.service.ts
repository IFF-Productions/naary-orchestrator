import { createHash, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";

/** sha256 hex — the only form of the token persisted; the plaintext is shown once. */
const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

/**
 * Per-tenant API tokens authenticate the control plane. Tokens are stored hashed
 * (never plaintext); the bearer presented on a request is hashed and looked up.
 */
@Injectable()
export class ApiTokenService {
  /** Mint a token for a tenant. Returns the id + PLAINTEXT once — only the sha256 is stored,
   *  so the plaintext can never be shown again. */
  async mint(
    tenantId: string,
    label: string,
    /** Absolute expiry (#1078 §3). Omitted/undefined ⇒ stored as NULL ⇒ non-expiring, which is
     *  what every Settings- and CI-minted token stays. Short-lived CLI tokens pass a value. */
    expiresAt?: Date,
  ): Promise<{ id: string; token: string; label: string; createdAt: Date }> {
    const token = `nry_${randomBytes(24).toString("base64url")}`;
    const row = await getPrisma().apiToken.create({
      data: {
        tenantId,
        label,
        tokenHash: hashToken(token),
        expiresAt: expiresAt ?? null,
      },
      select: { id: true, label: true, createdAt: true },
    });
    return { id: row.id, token, label: row.label, createdAt: row.createdAt };
  }

  /** A tenant's tokens — metadata only, never the token/hash (write-once).
   *  `groupCount` (additive, RBAC-GROUPS.md §4a slice G2): how many permission groups the
   *  token belongs to — the SPA's "Restricted" badge. One batched query (a relation
   *  `_count` in the same findMany), no per-row lookups. */
  async list(tenantId: string): Promise<
    {
      id: string;
      label: string;
      createdAt: Date;
      lastUsedAt: Date | null;
      groupCount: number;
    }[]
  > {
    const rows = await getPrisma().apiToken.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        label: true,
        createdAt: true,
        lastUsedAt: true,
        _count: { select: { groupMemberships: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      groupCount: r._count.groupMemberships,
    }));
  }

  /** Revoke a tenant's token by id (tenant-scoped). Returns true if a row was removed. */
  async revoke(tenantId: string, id: string): Promise<boolean> {
    const res = await getPrisma().apiToken.deleteMany({
      where: { id, tenantId },
    });
    return res.count > 0;
  }

  /** Resolve a bearer token to its tenant + optional env binding, or null if unknown. The env id
   *  is free (same row we already read for the tenant) — the token's bound env is authoritative for
   *  runs it starts (design ENVIRONMENTS.md §3, Slice 4). Null environmentId = unbound.
   *  Additionally returns the token ROW id (RBAC-GROUPS.md §4a, slice G1): the identity a
   *  WorkflowGrant hangs on when the workspace opts into group enforcement. Additive — the id
   *  is not the secret (the hash stays write-once) and callers that ignore it are unchanged. */
  async verify(token: string): Promise<{
    id: string;
    tenantId: string;
    environmentId: string | null;
  } | null> {
    const row = await getPrisma().apiToken.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!row) return null;
    // Expiry (#1078 §3). This is the ONLY place it is enforced, deliberately: REST, /api/v1 and
    // MCP all resolve their bearer through this method, so every surface inherits the check and
    // none of them can drift. NULL = non-expiring (existing tokens). Evaluated against the
    // SERVER's clock — a client's clock is never consulted. An expired token is indistinguishable
    // from an unknown one to the caller (both → null → 401), which is also the right disclosure.
    // Checked BEFORE the lastUsedAt stamp below so a dead token can't keep reporting itself as
    // recently active in Settings.
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
    // Best-effort last-used stamp; never block or fail auth on it.
    void getPrisma()
      .apiToken.update({
        where: { id: row.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => undefined);
    return {
      id: row.id,
      tenantId: row.tenantId,
      environmentId: row.environmentId,
    };
  }
}
