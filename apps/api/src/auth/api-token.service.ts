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
  /** Mint a token for a tenant. Returns the PLAINTEXT once — it is never stored. */
  async mint(tenantId: string, label: string): Promise<string> {
    const token = `nry_${randomBytes(24).toString("base64url")}`;
    await getPrisma().apiToken.create({
      data: { tenantId, label, tokenHash: hashToken(token) },
    });
    return token;
  }

  /** Resolve a bearer token to its tenantId, or null if unknown. */
  async verify(token: string): Promise<string | null> {
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
    return row.tenantId;
  }
}
