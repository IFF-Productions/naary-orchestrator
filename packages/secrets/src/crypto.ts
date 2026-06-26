import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

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

/** Build the encryptor from the required ENCRYPTION_KEY env var (fail at boot). */
export function createKeyEncryptor(): KeyEncryptor {
  const masterKey = process.env.ENCRYPTION_KEY;
  if (!masterKey) {
    throw new Error("ENCRYPTION_KEY is required");
  }
  return new AesGcmKeyEncryptor(masterKey);
}
