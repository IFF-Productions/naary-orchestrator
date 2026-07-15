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
  ): Promise<{ id: string; token: string; label: string; createdAt: Date }> {
    const token = `nry_${randomBytes(24).toString("base64url")}`;
    const row = await getPrisma().apiToken.create({
      data: { tenantId, label, tokenHash: hashToken(token) },
      select: { id: true, label: true, createdAt: true },
    });
    return { id: row.id, token, label: row.label, createdAt: row.createdAt };
  }

  /** A tenant's tokens — metadata only, never the token/hash (write-once). */
  async list(
    tenantId: string,
  ): Promise<
    { id: string; label: string; createdAt: Date; lastUsedAt: Date | null }[]
  > {
    return getPrisma().apiToken.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      select: { id: true, label: true, createdAt: true, lastUsedAt: true },
    });
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
   *  runs it starts (design ENVIRONMENTS.md §3, Slice 4). Null environmentId = unbound. */
  async verify(
    token: string,
  ): Promise<{ tenantId: string; environmentId: string | null } | null> {
    const row = await getPrisma().apiToken.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!row) return null;
    // Best-effort last-used stamp; never block or fail auth on it.
    void getPrisma()
      .apiToken.update({
        where: { id: row.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => undefined);
    return { tenantId: row.tenantId, environmentId: row.environmentId };
  }
}
