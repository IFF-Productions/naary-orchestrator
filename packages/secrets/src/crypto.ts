import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Ciphertext + the per-message nonce and GCM auth tag, all base64. */
export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/**
 * Envelope-style interface so the local AES implementation can be swapped for a
 * KMS-backed one (AWS KMS / Secrets Manager) without touching callers.
 */
export interface KeyEncryptor {
  encrypt(plaintext: string): EncryptedPayload;
  decrypt(payload: EncryptedPayload): string;
}

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the GCM standard

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

  encrypt(plaintext: string): EncryptedPayload {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
  }

  decrypt(payload: EncryptedPayload): string {
    const decipher = createDecipheriv(
      ALGORITHM,
      this.key,
      Buffer.from(payload.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
    // .final() throws if the auth tag doesn't match (tamper detection).
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
