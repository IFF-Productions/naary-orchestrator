import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for the TenantCredential table (env-scoped composite key).
type Row = Record<string, unknown> & {
  tenantId: string;
  environmentId: string;
  provider: string;
};
const store = new Map<string, Row>();
const key = (t: string, e: string, p: string) => `${t}::${e}::${p}`;

// In-memory TenantKey table (wrapped per-tenant DEKs) — the envelope layer reads/mints
// through this, so the round-trip below exercises REAL envelope crypto end to end.
const tenantKeys = new Map<string, Record<string, unknown>>();

vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    tenantKey: {
      findUnique: async ({ where }: any) =>
        tenantKeys.get(where.tenantId) ?? null,
      create: async ({ data }: any) => {
        if (tenantKeys.has(data.tenantId))
          throw Object.assign(new Error("unique constraint"), {
            code: "P2002",
          });
        tenantKeys.set(data.tenantId, data);
        return data;
      },
    },
    tenantCredential: {
      upsert: async ({ where, create, update }: any) => {
        const k = key(
          where.tenantId_environmentId_provider.tenantId,
          where.tenantId_environmentId_provider.environmentId,
          where.tenantId_environmentId_provider.provider,
        );
        const existing = store.get(k);
        const row = {
          id: existing?.id ?? `cred_${store.size + 1}`,
          ...(existing ?? create),
          ...update,
        };
        store.set(k, row as Row);
        return row;
      },
      findUnique: async ({ where }: any) =>
        store.get(
          key(
            where.tenantId_environmentId_provider.tenantId,
            where.tenantId_environmentId_provider.environmentId,
            where.tenantId_environmentId_provider.provider,
          ),
        ) ?? null,
    },
  }),
}));

import { AesGcmKeyEncryptor } from "../src/crypto";
import {
  CredentialsService,
  MissingCredentialError,
} from "../src/credentials.service";

const encryptor = new AesGcmKeyEncryptor(randomBytes(32).toString("hex"));
const PLAINTEXT = "tenant-provided-key-value-abcdef123456";

beforeEach(() => {
  store.clear();
  tenantKeys.clear();
});

describe("CredentialsService", () => {
  it("stores the key encrypted (not plaintext) and round-trips via getDecryptedKey", async () => {
    const svc = new CredentialsService({
      encryptor,
      validate: async () => true,
    });

    const saved = await svc.saveCredential("t1", "e1", "anthropic", PLAINTEXT);
    expect(saved.isValid).toBe(true);
    // saveCredential never returns the key
    expect(JSON.stringify(saved)).not.toContain(PLAINTEXT);

    // the stored row holds ciphertext, not the plaintext — at the ENVELOPE version
    const row = store.get("t1::e1::anthropic")!;
    expect(row.ciphertext).toBeTypeOf("string");
    expect(JSON.stringify(row)).not.toContain(PLAINTEXT);
    expect(row.keyVersion).toBe(3);

    // a wrapped per-tenant DEK was minted, and neither it nor the credential leaks into it
    const dek = tenantKeys.get("t1")!;
    expect(dek.ciphertext).toBeTypeOf("string");
    expect(JSON.stringify(dek)).not.toContain(PLAINTEXT);

    // and it decrypts back to the original
    expect(await svc.getDecryptedKey("t1", "e1", "anthropic")).toBe(PLAINTEXT);
  });

  it("still decrypts a LEGACY master-encrypted row (keyVersion 2, pre-envelope)", async () => {
    const svc = new CredentialsService({
      encryptor,
      validate: async () => true,
    });
    // Simulate a row written before envelope encryption: master key + AAD, v2.
    const enc = encryptor.encrypt(PLAINTEXT, "t1:anthropic");
    store.set("t1::e1::anthropic", {
      tenantId: "t1",
      environmentId: "e1",
      provider: "anthropic",
      ...enc,
      isValid: true,
    } as never);

    expect(await svc.getDecryptedKey("t1", "e1", "anthropic")).toBe(PLAINTEXT);
    expect(tenantKeys.size).toBe(0); // no DEK needed for a legacy read
  });

  it("marks an invalid key isValid=false and refuses to hand it back", async () => {
    const svc = new CredentialsService({
      encryptor,
      validate: async () => false,
    });

    const saved = await svc.saveCredential("t2", "e1", "anthropic", PLAINTEXT);
    expect(saved.isValid).toBe(false);

    await expect(
      svc.getDecryptedKey("t2", "e1", "anthropic"),
    ).rejects.toBeInstanceOf(MissingCredentialError);
  });

  it("throws MissingCredentialError when no credential exists", async () => {
    const svc = new CredentialsService({
      encryptor,
      validate: async () => true,
    });
    await expect(
      svc.getDecryptedKey("ghost", "e1", "anthropic"),
    ).rejects.toBeInstanceOf(MissingCredentialError);
  });
});
