import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  AesGcmKeyEncryptor,
  FallbackKeyEncryptor,
  createKeyEncryptor,
} from "../src/crypto";

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

  it("AAD binds ciphertext to its context (Sec#7): same aad round-trips, wrong aad throws", () => {
    const enc = new AesGcmKeyEncryptor(masterKey);
    const payload = enc.encrypt(SAMPLE_PLAINTEXT, "t1:anthropic");
    expect(payload.keyVersion).toBe(2); // current AAD-bound format
    expect(enc.decrypt(payload, "t1:anthropic")).toBe(SAMPLE_PLAINTEXT);
    // a row swapped into another tenant's slot fails to decrypt
    expect(() => enc.decrypt(payload, "t2:anthropic")).toThrow();
    // and dropping the aad on a v2 payload also fails
    expect(() => enc.decrypt(payload)).toThrow();
  });

  it("legacy (v1, no-AAD) payloads still decrypt without an aad — backward compatible", () => {
    const enc = new AesGcmKeyEncryptor(masterKey);
    const legacy = enc.encrypt(SAMPLE_PLAINTEXT); // no aad → keyVersion 1
    expect(legacy.keyVersion).toBe(1);
    expect(enc.decrypt(legacy)).toBe(SAMPLE_PLAINTEXT);
    // passing an aad to a v1 payload is ignored (still decrypts)
    expect(enc.decrypt(legacy, "t1:anthropic")).toBe(SAMPLE_PLAINTEXT);
  });
});

describe("FallbackKeyEncryptor (master rotation window)", () => {
  const oldKey = new AesGcmKeyEncryptor(randomBytes(32).toString("hex"));
  const newKey = new AesGcmKeyEncryptor(randomBytes(32).toString("hex"));
  const chain = new FallbackKeyEncryptor(newKey, [oldKey]);

  it("encrypts with the NEW key only (never a retired key)", () => {
    const payload = chain.encrypt(SAMPLE_PLAINTEXT, "aad");
    expect(newKey.decrypt(payload, "aad")).toBe(SAMPLE_PLAINTEXT);
    expect(() => oldKey.decrypt(payload, "aad")).toThrow();
  });

  it("decrypts material written under EITHER key (zero-downtime rotation)", () => {
    const oldPayload = oldKey.encrypt(SAMPLE_PLAINTEXT, "aad");
    const newPayload = newKey.encrypt(SAMPLE_PLAINTEXT, "aad");
    expect(chain.decrypt(oldPayload, "aad")).toBe(SAMPLE_PLAINTEXT);
    expect(chain.decrypt(newPayload, "aad")).toBe(SAMPLE_PLAINTEXT);
  });

  it("still fails on material NO key can decrypt, and on a wrong AAD", () => {
    const stranger = new AesGcmKeyEncryptor(randomBytes(32).toString("hex"));
    expect(() =>
      chain.decrypt(stranger.encrypt(SAMPLE_PLAINTEXT, "aad"), "aad"),
    ).toThrow();
    // AAD mismatch must not be "rescued" by a retired key.
    expect(() =>
      chain.decrypt(newKey.encrypt(SAMPLE_PLAINTEXT, "aad"), "other"),
    ).toThrow();
  });
});

describe("createKeyEncryptor + OLD_ENCRYPTION_KEY", () => {
  const saved = {
    key: process.env.ENCRYPTION_KEY,
    old: process.env.OLD_ENCRYPTION_KEY,
  };
  afterEach(() => {
    if (saved.key === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = saved.key;
    if (saved.old === undefined) delete process.env.OLD_ENCRYPTION_KEY;
    else process.env.OLD_ENCRYPTION_KEY = saved.old;
  });

  it("builds a fallback chain from OLD_ENCRYPTION_KEY that reads old material", () => {
    const oldHex = randomBytes(32).toString("hex");
    const newHex = randomBytes(32).toString("hex");
    const oldPayload = new AesGcmKeyEncryptor(oldHex).encrypt(
      SAMPLE_PLAINTEXT,
      "aad",
    );

    process.env.ENCRYPTION_KEY = newHex;
    process.env.OLD_ENCRYPTION_KEY = oldHex;
    const enc = createKeyEncryptor();

    expect(enc.decrypt(oldPayload, "aad")).toBe(SAMPLE_PLAINTEXT); // old still reads
    // …but writes go under the NEW key.
    const written = enc.encrypt(SAMPLE_PLAINTEXT, "aad");
    expect(new AesGcmKeyEncryptor(newHex).decrypt(written, "aad")).toBe(
      SAMPLE_PLAINTEXT,
    );
  });

  it("a blank OLD_ENCRYPTION_KEY yields the plain single-key encryptor", () => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
    process.env.OLD_ENCRYPTION_KEY = "  ";
    expect(createKeyEncryptor()).toBeInstanceOf(AesGcmKeyEncryptor);
  });
});
