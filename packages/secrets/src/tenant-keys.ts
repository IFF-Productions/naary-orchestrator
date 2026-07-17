import { randomBytes } from "node:crypto";
import { getPrisma } from "@naary/db";
import {
  AesGcmKeyEncryptor,
  type EncryptedPayload,
  type KeyEncryptor,
  createKeyEncryptor,
} from "./crypto";

/** At-rest format written with a per-tenant DEK. Rows below this version are legacy
 *  master-key ciphertexts (1 = no AAD, 2 = AAD-bound) and keep decrypting unchanged. */
export const TENANT_KEY_VERSION = 3;

/** AAD binding a WRAPPED DEK to its tenant — a TenantKey row swapped between tenants
 *  fails to unwrap (same Sec#7 property the credential rows have). */
function dekAad(tenantId: string): string {
  return `dek:${tenantId}`;
}

/**
 * Envelope encryption (Sec: per-tenant crypto isolation). Each tenant gets its own
 * random 32-byte data-encryption key (DEK); the master ENCRYPTION_KEY only WRAPS
 * DEKs (it is the KEK), so:
 *  - a leaked DEK exposes one tenant, never the fleet;
 *  - master rotation re-wraps the small TenantKey rows instead of every secret;
 *  - deleting a tenant's TenantKey row crypto-shreds all their v3 secrets AT REST.
 *    NB: a process that already unwrapped the DEK can keep using its cached copy
 *    until eviction/restart — a tenant-deletion flow should call `evict(tenantId)`
 *    after deleting the row (other processes converge on restart / LRU churn).
 *
 * Writes always use the DEK (keyVersion 3). Reads route by the row's keyVersion, so
 * pre-existing master-encrypted rows (v1/v2) decrypt without any data migration —
 * they converge to v3 as they are re-saved.
 *
 * The plaintext DEK lives in process memory only (never returned, logged, or put in
 * telemetry). Unwrapped DEKs are cached per instance (LRU-bounded); DEKs are
 * immutable so cached entries never go stale.
 */
export class TenantKeyService {
  /** Default DEK-cache bound. One entry is tiny (a 32-byte key + object), but a
   *  long-lived worker serving many tenants shouldn't grow without limit. Evicting
   *  a live tenant is harmless — the next use re-reads + re-unwraps its row. */
  static readonly DEFAULT_MAX_CACHED_DEKS = 10_000;

  private readonly master: KeyEncryptor;
  private readonly maxCachedDeks: number;
  /** tenantId → in-flight/settled DEK cipher, in LRU order (Map insertion order;
   *  hits re-insert). Promise-valued so concurrent first uses share one mint
   *  instead of racing several. */
  private readonly deks = new Map<string, Promise<KeyEncryptor>>();

  constructor(opts?: { master?: KeyEncryptor; maxCachedDeks?: number }) {
    this.master = opts?.master ?? createKeyEncryptor();
    this.maxCachedDeks =
      opts?.maxCachedDeks ?? TenantKeyService.DEFAULT_MAX_CACHED_DEKS;
  }

  /** Drop a tenant's cached DEK. Call after deleting their TenantKey row so
   *  crypto-shredding takes effect in THIS process immediately. */
  evict(tenantId: string): void {
    this.deks.delete(tenantId);
  }

  /** Encrypt with the tenant's DEK (minting it on first use). Always emits v3. */
  async encrypt(
    tenantId: string,
    plaintext: string,
    aad: string,
  ): Promise<EncryptedPayload> {
    const dek = await this.dekFor(tenantId);
    return { ...dek.encrypt(plaintext, aad), keyVersion: TENANT_KEY_VERSION };
  }

  /** Decrypt by the payload's keyVersion: v3 → tenant DEK; v1/v2 → legacy master. */
  async decrypt(
    tenantId: string,
    payload: EncryptedPayload,
    aad: string,
  ): Promise<string> {
    if ((payload.keyVersion ?? 1) >= TENANT_KEY_VERSION) {
      const dek = await this.dekFor(tenantId);
      return dek.decrypt(payload, aad);
    }
    return this.master.decrypt(payload, aad);
  }

  private dekFor(tenantId: string): Promise<KeyEncryptor> {
    const cached = this.deks.get(tenantId);
    if (cached) {
      // LRU touch: re-insert so Map iteration order tracks recency.
      this.deks.delete(tenantId);
      this.deks.set(tenantId, cached);
      return cached;
    }
    const dek = this.loadOrMint(tenantId);
    // Drop a failed load (transient DB error) so the next call retries instead of
    // caching the rejection forever.
    dek.catch(() => this.deks.delete(tenantId));
    this.deks.set(tenantId, dek);
    if (this.deks.size > this.maxCachedDeks) {
      // Evict the least-recently-used entry (first in iteration order).
      const oldest = this.deks.keys().next().value;
      if (oldest !== undefined) this.deks.delete(oldest);
    }
    return dek;
  }

  private async loadOrMint(tenantId: string): Promise<KeyEncryptor> {
    const prisma = getPrisma();
    let row = await prisma.tenantKey.findUnique({ where: { tenantId } });
    if (!row) {
      const wrapped = this.master.encrypt(
        randomBytes(32).toString("hex"),
        dekAad(tenantId),
      );
      try {
        row = await prisma.tenantKey.create({
          data: {
            tenantId,
            ciphertext: wrapped.ciphertext,
            iv: wrapped.iv,
            authTag: wrapped.authTag,
            keyVersion: wrapped.keyVersion ?? 1,
          },
        });
      } catch (err) {
        // Cross-process mint race (unique violation): the winner's DEK is THE key for
        // this tenant — re-read it. Anything else (row still absent) is a real error.
        row = await prisma.tenantKey.findUnique({ where: { tenantId } });
        if (!row) throw err;
      }
    }
    const dekHex = this.master.decrypt(
      {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
        keyVersion: row.keyVersion,
      },
      dekAad(tenantId),
    );
    return new AesGcmKeyEncryptor(dekHex);
  }
}

/** Process-wide default, so the many ad-hoc `new SecretStore()` / `new CredentialsService()`
 *  call sites share ONE DEK cache (one DB read + unwrap per tenant per process). Lazy: the
 *  ENCRYPTION_KEY requirement still surfaces at first use, as before. */
let defaultService: TenantKeyService | undefined;
export function getTenantKeyService(): TenantKeyService {
  return (defaultService ??= new TenantKeyService());
}
