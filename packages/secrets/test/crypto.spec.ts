import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AesGcmKeyEncryptor } from "../src/crypto";

const masterKey = randomBytes(32).toString("hex");
// A stand-in for a provider key — deliberately NOT key-shaped, to avoid tripping
// the no-secrets hook (and because the value is irrelevant to the crypto test).
const SAMPLE_PLAINTEXT = "provider-key-placeholder-value-1234567890";

describe("AesGcmKeyEncryptor", () => {
  it("round-trips: decrypt(encrypt(x)) === x", () => {
    const enc = new AesGcmKeyEncryptor(masterKey);
    const payload = enc.encrypt(SAMPLE_PLAINTEXT);

    expect(payload.ciphertext).not.toContain(SAMPLE_PLAINTEXT);
    expect(enc.decrypt(payload)).toBe(SAMPLE_PLAINTEXT);
  });

  it("uses a fresh IV per call (same plaintext → different ciphertext)", () => {
    const enc = new AesGcmKeyEncryptor(masterKey);
    const a = enc.encrypt("same");
    const b = enc.encrypt("same");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("throws when the authTag is tampered with", () => {
    const enc = new AesGcmKeyEncryptor(masterKey);
    const payload = enc.encrypt(SAMPLE_PLAINTEXT);
    const tampered = {
      ...payload,
      authTag: randomBytes(16).toString("base64"),
    };
    expect(() => enc.decrypt(tampered)).toThrow();
  });

  it("throws when ciphertext is tampered with", () => {
    const enc = new AesGcmKeyEncryptor(masterKey);
    const payload = enc.encrypt(SAMPLE_PLAINTEXT);
    const bytes = Buffer.from(payload.ciphertext, "base64");
    bytes[0] ^= 0xff;
    expect(() =>
      enc.decrypt({ ...payload, ciphertext: bytes.toString("base64") }),
    ).toThrow();
  });

  it("rejects a master key that is not 32 bytes", () => {
    expect(() => new AesGcmKeyEncryptor("abcd")).toThrow(/32 bytes/);
  });
});
