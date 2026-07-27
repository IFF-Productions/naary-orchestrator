import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { encryptionKey, oldEncryptionKeys } from "./config";

/** Ciphertext + the per-message nonce and GCM auth tag, all base64.
 *  `keyVersion` tags the at-rest format (Sec#7): absent/1 = legacy (no AAD),
 *  2 = current (AAD-bound). It is also the hook for future key rotation
 *  (decrypt-by-version). */
export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion?: number;
}

/**
 * Envelope-style interface so the local AES implementation can be swapped for a
 * KMS-backed one (AWS KMS / Secrets Manager) without touching callers.
 *
 * `aad` (Additional Authenticated Data, Sec#7) binds the ciphertext to its
 * context — e.g. "<tenantId>:<key>" — so a party with DB write access cannot swap
 * one tenant's encrypted row for another's without GCM detecting it. The SAME aad
 * must be supplied on decrypt.
 */
export interface KeyEncryptor {
  encrypt(plaintext: string, aad?: string): EncryptedPayload;
  decrypt(payload: EncryptedPayload, aad?: string): string;
}

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
/** Current at-rest format: AAD-bound. v1 (legacy) had no AAD. */
const CURRENT_KEY_VERSION = 2;

/** AES-256-GCM using a 32-byte master key held in memory. */
export class AesGcmKeyEncryptor implements KeyEncryptor {
  private readonly key: Buffer;

  constructor(masterKeyHex: string) {
    const key = Buffer.from(masterKeyHex, "hex");
    if (key.length !== 32) {
      throw new Error(
        `ENCRYPTION_KEY must be 32 bytes (64 hex chars); decoded ${key.length}`,
      );
    }
    this.key = key;
  }

  encrypt(plaintext: string, aad?: string): EncryptedPayload {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    // Bind to context when an aad is given (current v2 format). Encrypting WITHOUT
    // an aad stays v1 — only used by callers that don't supply context.
    if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      keyVersion: aad !== undefined ? CURRENT_KEY_VERSION : 1,
    };
  }

  decrypt(payload: EncryptedPayload, aad?: string): string {
    const decipher = createDecipheriv(
      ALGORITHM,
      this.key,
      Buffer.from(payload.iv, "base64"),
    );
    // AAD applies only for the current (v2) format; legacy rows (v1/absent) were
    // written without AAD, so they decrypt without it — backward compatible.
    if ((payload.keyVersion ?? 1) >= 2 && aad !== undefined) {
      decipher.setAAD(Buffer.from(aad, "utf8"));
    }
    decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
    // .final() throws if the auth tag (or AAD binding) doesn't match — tamper +
    // wrong-context detection.
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  }
}

/**
 * Decrypt-fallback chain for MASTER-KEY ROTATION: `encrypt` always uses the primary
 * (new) key; `decrypt` tries the primary first, then each retired key in order. GCM's
 * auth tag makes try-in-order safe — a wrong key fails authentication, it can never
 * "successfully" decrypt to garbage. This is what makes rotation zero-downtime:
 * deploy with ENCRYPTION_KEY=<new> + OLD_ENCRYPTION_KEY=<old> (everything old still
 * decrypts), run the rewrap script (scripts: rotate-master-key), then drop the old var.
 */
export class FallbackKeyEncryptor implements KeyEncryptor {
  constructor(
    private readonly primary: KeyEncryptor,
    private readonly retired: KeyEncryptor[],
  ) {}

  encrypt(plaintext: string, aad?: string): EncryptedPayload {
    return this.primary.encrypt(plaintext, aad);
  }

  decrypt(payload: EncryptedPayload, aad?: string): string {
    try {
      return this.primary.decrypt(payload, aad);
    } catch (err) {
      for (const key of this.retired) {
        try {
          return key.decrypt(payload, aad);
        } catch {
          // wrong key — GCM auth failed; try the next retired key
        }
      }
      throw err; // preserve the primary's failure (most useful error)
    }
  }
}

/**
 * Build the encryptor from the required ENCRYPTION_KEY env var (fail at boot).
 * OLD_ENCRYPTION_KEY (comma-separated for multiple retired keys) adds decrypt-only
 * fallbacks for the master-rotation window — see FallbackKeyEncryptor.
 */
export function createKeyEncryptor(): KeyEncryptor {
  const masterKey = encryptionKey();
  if (!masterKey) {
    throw new Error("ENCRYPTION_KEY is required");
  }
  const primary = new AesGcmKeyEncryptor(masterKey);
  const retired = oldEncryptionKeys().map((k) => new AesGcmKeyEncryptor(k));
  return retired.length > 0
    ? new FallbackKeyEncryptor(primary, retired)
    : primary;
}
