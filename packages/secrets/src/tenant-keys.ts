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
 *  - deleting a tenant's TenantKey row crypto-shreds all their v3 secrets.
 *
 * Writes always use the DEK (keyVersion 3). Reads route by the row's keyVersion, so
 * pre-existing master-encrypted rows (v1/v2) decrypt without any data migration —
 * they converge to v3 as they are re-saved.
 *
 * The plaintext DEK lives in process memory only (never returned, logged, or put in
 * telemetry). Unwrapped DEKs are cached per instance; DEKs are immutable so the cache
 * never needs invalidation.
 */
export class TenantKeyService {
  private readonly master: KeyEncryptor;
  /** tenantId → in-flight/settled DEK cipher. Promise-valued so concurrent first
   *  uses share one mint instead of racing several. */
  private readonly deks = new Map<string, Promise<KeyEncryptor>>();

  constructor(opts?: { master?: KeyEncryptor }) {
    this.master = opts?.master ?? createKeyEncryptor();
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
    let dek = this.deks.get(tenantId);
    if (!dek) {
      dek = this.loadOrMint(tenantId);
      // Drop a failed load (transient DB error) so the next call retries instead of
      // caching the rejection forever.
      dek.catch(() => this.deks.delete(tenantId));
      this.deks.set(tenantId, dek);
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
