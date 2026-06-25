import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for the TenantCredential table.
type Row = Record<string, unknown> & { tenantId: string; provider: string };
const store = new Map<string, Row>();
const key = (t: string, p: string) => `${t}::${p}`;

vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    tenantCredential: {
      upsert: async ({ where, create, update }: any) => {
        const k = key(
          where.tenantId_provider.tenantId,
          where.tenantId_provider.provider,
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
            where.tenantId_provider.tenantId,
            where.tenantId_provider.provider,
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

beforeEach(() => store.clear());

describe("CredentialsService", () => {
  it("stores the key encrypted (not plaintext) and round-trips via getDecryptedKey", async () => {
    const svc = new CredentialsService({
      encryptor,
      validate: async () => true,
    });

    const saved = await svc.saveCredential("t1", "anthropic", PLAINTEXT);
    expect(saved.isValid).toBe(true);
    // saveCredential never returns the key
    expect(JSON.stringify(saved)).not.toContain(PLAINTEXT);

    // the stored row holds ciphertext, not the plaintext
    const row = store.get("t1::anthropic")!;
    expect(row.ciphertext).toBeTypeOf("string");
    expect(JSON.stringify(row)).not.toContain(PLAINTEXT);

    // and it decrypts back to the original
    expect(await svc.getDecryptedKey("t1", "anthropic")).toBe(PLAINTEXT);
  });

  it("marks an invalid key isValid=false and refuses to hand it back", async () => {
    const svc = new CredentialsService({
      encryptor,
      validate: async () => false,
    });

    const saved = await svc.saveCredential("t2", "anthropic", PLAINTEXT);
    expect(saved.isValid).toBe(false);

    await expect(svc.getDecryptedKey("t2", "anthropic")).rejects.toBeInstanceOf(
      MissingCredentialError,
    );
  });

  it("throws MissingCredentialError when no credential exists", async () => {
    const svc = new CredentialsService({
      encryptor,
      validate: async () => true,
    });
    await expect(
      svc.getDecryptedKey("ghost", "anthropic"),
    ).rejects.toBeInstanceOf(MissingCredentialError);
  });
});
