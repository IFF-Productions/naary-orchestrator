import { getPrisma } from "@naary/db";
import { type KeyEncryptor } from "./crypto";
import { TenantKeyService, getTenantKeyService } from "./tenant-keys";

/**
 * Generic encrypted secret store, keyed by (tenantId, environmentId, key) since Slice 5 — secrets
 * are env-scoped (a sandbox connection's PAT ≠ prod's). Reuses the same per-tenant envelope
 * encryption (TenantKeyService) + the TenantCredential table as the BYOK store, but without the Anthropic-specific validation in
 * CredentialsService — for storing connection PATs and OAuth refresh tokens (Slice #4), keyed e.g.
 * `conn:<id>`. NB the at-rest AAD stays bound to (tenantId, key), NOT env — env is a row-lookup
 * dimension only, so a backfilled row still decrypts. Plaintext is returned in memory only; never logged.
 */
export class SecretStore {
  private readonly keys: TenantKeyService;

  /** `encryptor` (kept positional for existing call sites/tests) is the MASTER key —
   *  it becomes the KEK of a fresh envelope service. Default: the shared process-wide
   *  TenantKeyService (one DEK cache across the many ad-hoc SecretStore instances). */
  constructor(encryptor?: KeyEncryptor, tenantKeys?: TenantKeyService) {
    this.keys =
      tenantKeys ??
      (encryptor
        ? new TenantKeyService({ master: encryptor })
        : getTenantKeyService());
  }

  /** AAD binds the ciphertext to its (tenant, key) slot (Sec#7) — a swapped row
   *  fails to decrypt. */
  private aad(tenantId: string, key: string): string {
    return `${tenantId}:${key}`;
  }

  async put(
    tenantId: string,
    environmentId: string,
    key: string,
    plaintext: string,
  ): Promise<void> {
    const enc = await this.keys.encrypt(
      tenantId,
      plaintext,
      this.aad(tenantId, key),
    );
    await getPrisma().tenantCredential.upsert({
      where: {
        tenantId_environmentId_provider: {
          tenantId,
          environmentId,
          provider: key,
        },
      },
      create: {
        tenantId,
        environmentId,
        provider: key,
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        keyVersion: enc.keyVersion ?? 1,
        isValid: true,
        lastValidatedAt: new Date(),
      },
      update: {
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        keyVersion: enc.keyVersion ?? 1,
        isValid: true,
        lastValidatedAt: new Date(),
      },
    });
  }

  async get(
    tenantId: string,
    environmentId: string,
    key: string,
  ): Promise<string | null> {
    const row = await getPrisma().tenantCredential.findUnique({
      where: {
        tenantId_environmentId_provider: {
          tenantId,
          environmentId,
          provider: key,
        },
      },
    });
    if (!row) return null;
    // Routed by keyVersion: v3 rows use the tenant DEK; legacy v1/v2 rows the master key.
    return this.keys.decrypt(
      tenantId,
      {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
        keyVersion: row.keyVersion,
      },
      this.aad(tenantId, key),
    );
  }

  /**
   * Delete a tenant's entries whose key starts with `keyPrefix` and whose row is
   * older than `olderThanMs` (by `createdAt`). Decryption-free storage hygiene —
   * used to sweep abandoned, TTL-past records (e.g. never-completed OAuth states,
   * audit S-5). Returns the number deleted. Best-effort; safe to run opportunistically.
   */
  async prunePrefixOlderThan(
    tenantId: string,
    environmentId: string,
    keyPrefix: string,
    olderThanMs: number,
  ): Promise<number> {
    const res = await getPrisma().tenantCredential.deleteMany({
      where: {
        tenantId,
        environmentId,
        provider: { startsWith: keyPrefix },
        createdAt: { lt: new Date(Date.now() - olderThanMs) },
      },
    });
    return res.count;
  }

  /**
   * List the KEYS (not values) for a tenant+env whose key starts with `keyPrefix`, with the prefix
   * stripped — e.g. `keyPrefix: "secret:"` yields the user-facing secret NAMES. Never decrypts: this
   * is the read behind a write-only management UI, so the ciphertext never leaves the DB. Key-sorted.
   */
  async listKeys(
    tenantId: string,
    environmentId: string,
    keyPrefix: string,
  ): Promise<string[]> {
    const rows = await getPrisma().tenantCredential.findMany({
      where: { tenantId, environmentId, provider: { startsWith: keyPrefix } },
      select: { provider: true },
      orderBy: { provider: "asc" },
    });
    return rows.map((r) => r.provider.slice(keyPrefix.length));
  }

  async remove(
    tenantId: string,
    environmentId: string,
    key: string,
  ): Promise<void> {
    await getPrisma().tenantCredential.deleteMany({
      where: { tenantId, environmentId, provider: key },
    });
  }

  // --- Tenant-wide (global) secrets (#459) -----------------------------------------------------
  // A named secret that applies to EVERY environment, backed by the SEPARATE TenantSecret table
  // (not a null-env TenantCredential row — that would break its env FK + unique). Same key namespace
  // and the SAME env-independent AAD `${tenantId}:${key}`, so a global secret's ciphertext is
  // crypto-identical to an env secret of the same name — only the row's table/lookup dimension differs.

  /** Create or replace a TENANT-WIDE secret (upsert by `{ tenantId, key }`). */
  async putGlobal(
    tenantId: string,
    key: string,
    plaintext: string,
  ): Promise<void> {
    const enc = await this.keys.encrypt(
      tenantId,
      plaintext,
      this.aad(tenantId, key),
    );
    await getPrisma().tenantSecret.upsert({
      where: { tenantId_key: { tenantId, key } },
      create: {
        tenantId,
        key,
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        keyVersion: enc.keyVersion ?? 1,
      },
      update: {
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        keyVersion: enc.keyVersion ?? 1,
      },
    });
  }

  /** Decrypt a TENANT-WIDE secret (null if not set). Routed by keyVersion, same as `get`. */
  async getGlobal(tenantId: string, key: string): Promise<string | null> {
    const row = await getPrisma().tenantSecret.findUnique({
      where: { tenantId_key: { tenantId, key } },
    });
    if (!row) return null;
    return this.keys.decrypt(
      tenantId,
      {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
        keyVersion: row.keyVersion,
      },
      this.aad(tenantId, key),
    );
  }

  /** List TENANT-WIDE secret KEYS (not values) with `keyPrefix` stripped, key-sorted. Never decrypts —
   *  the read behind the write-only management UI, so ciphertext never leaves the DB. */
  async listGlobalKeys(tenantId: string, keyPrefix: string): Promise<string[]> {
    const rows = await getPrisma().tenantSecret.findMany({
      where: { tenantId, key: { startsWith: keyPrefix } },
      select: { key: true },
      orderBy: { key: "asc" },
    });
    return rows.map((r) => r.key.slice(keyPrefix.length));
  }

  /** Delete a TENANT-WIDE secret (no-op if absent). */
  async removeGlobal(tenantId: string, key: string): Promise<void> {
    await getPrisma().tenantSecret.deleteMany({
      where: { tenantId, key },
    });
  }

  /** Resolve a secret with per-env OVERRIDE precedence (#459): the env-specific value WINS; only when
   *  there is no env secret of this name does the tenant-wide value apply. This is the security-critical
   *  behavior — a tenant-wide secret must never shadow a per-env override. */
  async getWithGlobalFallback(
    tenantId: string,
    environmentId: string,
    key: string,
  ): Promise<string | null> {
    const env = await this.get(tenantId, environmentId, key);
    return env !== null ? env : this.getGlobal(tenantId, key);
  }

  /** Remove a tenant's secret for `key` across ALL environments. For GLOBALLY-UNIQUE keys only
   *  (e.g. `conn:<connectionId>` — a connection id can't collide across envs), so this deletes the
   *  single matching row without needing to know its env. Lets a caller purge a connection's secret
   *  even when the connection row is already gone (avoids orphaned `conn:<id>` rows). */
  async removeAllEnvs(tenantId: string, key: string): Promise<void> {
    await getPrisma().tenantCredential.deleteMany({
      where: { tenantId, provider: key },
    });
  }
}
