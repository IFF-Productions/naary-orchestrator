import { getPrisma } from "@naary/db";
import { type KeyEncryptor, createKeyEncryptor } from "./crypto";

/**
 * Generic encrypted secret store, keyed by (tenantId, key). Reuses the same
 * AES-256-GCM encryptor + the TenantCredential table as the BYOK store, but
 * without the Anthropic-specific validation in CredentialsService — for storing
 * connection PATs and OAuth refresh tokens (Slice #4), keyed e.g. `conn:<id>`.
 * Plaintext is returned in memory only; never logged.
 */
export class SecretStore {
  private readonly encryptor: KeyEncryptor;

  constructor(encryptor?: KeyEncryptor) {
    this.encryptor = encryptor ?? createKeyEncryptor();
  }

  /** AAD binds the ciphertext to its (tenant, key) slot (Sec#7) — a swapped row
   *  fails to decrypt. */
  private aad(tenantId: string, key: string): string {
    return `${tenantId}:${key}`;
  }

  async put(tenantId: string, key: string, plaintext: string): Promise<void> {
    const enc = this.encryptor.encrypt(plaintext, this.aad(tenantId, key));
    await getPrisma().tenantCredential.upsert({
      where: { tenantId_provider: { tenantId, provider: key } },
      create: {
        tenantId,
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

  async get(tenantId: string, key: string): Promise<string | null> {
    const row = await getPrisma().tenantCredential.findUnique({
      where: { tenantId_provider: { tenantId, provider: key } },
    });
    if (!row) return null;
    return this.encryptor.decrypt(
      {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
        keyVersion: row.keyVersion,
      },
      this.aad(tenantId, key),
    );
  }

  async remove(tenantId: string, key: string): Promise<void> {
    await getPrisma().tenantCredential.deleteMany({
      where: { tenantId, provider: key },
    });
  }
}
