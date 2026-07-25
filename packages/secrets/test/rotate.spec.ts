import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory tables for the three swept stores.
const tenantKeys = new Map<string, any>();
const creds = new Map<string, any>();
const hooks = new Map<string, any>();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    tenantKey: {
      findMany: async () => [...tenantKeys.values()],
      findUnique: async ({ where }: any) =>
        tenantKeys.get(where.tenantId) ?? null,
      create: async ({ data }: any) => {
        if (tenantKeys.has(data.tenantId))
          throw Object.assign(new Error("unique"), { code: "P2002" });
        tenantKeys.set(data.tenantId, data);
        return data;
      },
      update: async ({ where, data }: any) => {
        const row = { ...tenantKeys.get(where.tenantId), ...data };
        tenantKeys.set(where.tenantId, row);
        return row;
      },
    },
    tenantCredential: {
      // Honours BOTH bounds of the sweep's filter, so the `gt: 0` that excludes EXTERNAL
      // (Vault-backed, keyVersion 0) rows is actually exercised (#458).
      findMany: async ({ where }: any) =>
        [...creds.values()].filter(
          (r) =>
            r.keyVersion < where.keyVersion.lt &&
            (where.keyVersion.gt === undefined ||
              r.keyVersion > where.keyVersion.gt),
        ),
      update: async ({ where, data }: any) => {
        const row = { ...creds.get(where.id), ...data };
        creds.set(where.id, row);
        return row;
      },
    },
    webhookEndpoint: {
      findMany: async () =>
        [...hooks.values()].map(({ id, tenantId, signingSecret }) => ({
          id,
          tenantId,
          signingSecret,
        })),
      update: async ({ where, data }: any) => {
        const row = { ...hooks.get(where.id), ...data };
        hooks.set(where.id, row);
        return row;
      },
    },
  }),
}));

import { AesGcmKeyEncryptor, FallbackKeyEncryptor } from "../src/crypto";
import { rotateMasterKey } from "../src/rotate";
import { TenantKeyService, dekAad } from "../src/tenant-keys";

const oldMaster = new AesGcmKeyEncryptor(randomBytes(32).toString("hex"));
const newMaster = new AesGcmKeyEncryptor(randomBytes(32).toString("hex"));
/** The rotation-window chain: encrypts NEW, still decrypts OLD. */
const chain = new FallbackKeyEncryptor(newMaster, [oldMaster]);

const API_KEY = "fake-provider-key-value-123456";
const HOOK_SECRET = "hook-hmac-secret-value";

/** Seed the world as it looked BEFORE rotation, written under the OLD master:
 *  a wrapped DEK, a v3 credential under that DEK, a legacy v2 credential, and
 *  a v2 webhook signing secret. */
async function seedOldWorld(): Promise<void> {
  const oldSvc = new TenantKeyService({ master: oldMaster });
  const v3 = await oldSvc.encrypt("t1", API_KEY, "t1:anthropic");
  creds.set("cred_v3", {
    id: "cred_v3",
    tenantId: "t1",
    provider: "anthropic",
    ...v3,
  });
  const v2 = oldMaster.encrypt(API_KEY, "t1:openai");
  creds.set("cred_v2", {
    id: "cred_v2",
    tenantId: "t1",
    provider: "openai",
    ...v2,
  });
  hooks.set("ep_1", {
    id: "ep_1",
    tenantId: "t1",
    signingSecret: JSON.stringify(oldMaster.encrypt(HOOK_SECRET, "t1")),
  });
}

beforeEach(async () => {
  tenantKeys.clear();
  creds.clear();
  hooks.clear();
  await seedOldWorld();
});

describe("rotateMasterKey", () => {
  it("re-wraps DEKs under the NEW master and converges legacy rows to v3", async () => {
    const res = await rotateMasterKey({ master: chain });

    expect(res).toMatchObject({
      tenantKeysRewrapped: 1,
      credentialsConverged: 1,
      webhookSecretsConverged: 1,
      failures: [],
    });

    // The wrapped DEK now unwraps under the NEW master ALONE (old key retired).
    const dekRow = tenantKeys.get("t1")!;
    expect(() =>
      newMaster.decrypt(
        {
          ciphertext: dekRow.ciphertext,
          iv: dekRow.iv,
          authTag: dekRow.authTag,
          keyVersion: dekRow.keyVersion,
        },
        dekAad("t1"),
      ),
    ).not.toThrow();

    // Every row is v3 and readable through a service that has ONLY the new master —
    // i.e. OLD_ENCRYPTION_KEY can be dropped after the sweep.
    const newOnly = new TenantKeyService({ master: newMaster });
    for (const id of ["cred_v3", "cred_v2"]) {
      const row = creds.get(id)!;
      expect(row.keyVersion).toBe(3);
      expect(
        await newOnly.decrypt(
          "t1",
          {
            ciphertext: row.ciphertext,
            iv: row.iv,
            authTag: row.authTag,
            keyVersion: row.keyVersion,
          },
          `t1:${row.provider}`,
        ),
      ).toBe(API_KEY);
    }
    const hook = JSON.parse(hooks.get("ep_1")!.signingSecret);
    expect(hook.keyVersion).toBe(3);
    expect(await newOnly.decrypt("t1", hook, "t1")).toBe(HOOK_SECRET);
  });

  it("is idempotent: a second run rewraps DEKs again but finds no sub-v3 rows", async () => {
    await rotateMasterKey({ master: chain });
    const second = await rotateMasterKey({ master: chain });
    expect(second).toMatchObject({
      tenantKeysRewrapped: 1, // rewrap under the same primary — harmless
      credentialsConverged: 0,
      webhookSecretsConverged: 0,
      failures: [],
    });
  });

  it("--dry-run reports what WOULD change and writes nothing", async () => {
    const before = {
      dek: { ...tenantKeys.get("t1") },
      cred: { ...creds.get("cred_v2") },
      hook: { ...hooks.get("ep_1") },
    };
    const res = await rotateMasterKey({ master: chain, dryRun: true });
    expect(res).toMatchObject({
      tenantKeysRewrapped: 1,
      credentialsConverged: 1,
      webhookSecretsConverged: 1,
    });
    expect(tenantKeys.get("t1")).toEqual(before.dek);
    expect(creds.get("cred_v2")).toEqual(before.cred);
    expect(hooks.get("ep_1")).toEqual(before.hook);
  });

  it("collects per-row failures (error NAME only) and keeps sweeping", async () => {
    // A credential row whose ciphertext no master can decrypt (e.g. lost key).
    creds.set("cred_bad", {
      id: "cred_bad",
      tenantId: "t1",
      provider: "google",
      ...oldMaster.encrypt(API_KEY, "t1:google"),
      ciphertext: Buffer.from("garbage-not-valid").toString("base64"),
    });

    const res = await rotateMasterKey({ master: chain });

    expect(res.credentialsConverged).toBe(1); // the good row still converged
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]).toMatchObject({
      table: "TenantCredential",
      id: "cred_bad",
    });
    // failure report carries no key material and no message
    expect(JSON.stringify(res.failures)).not.toContain(API_KEY);
    expect(Object.keys(res.failures[0]).sort()).toEqual([
      "errorName",
      "id",
      "table",
    ]);
  });

  it("SKIPS external (Vault-backed, keyVersion 0) rows rather than failing on them (#458)", async () => {
    // A row whose material lives in Vault: the crypto columns are empty BY DESIGN. The sweep
    // must not try to master-decrypt it — otherwise every Vault-backed row is reported as a
    // failure and rotation can never be certified complete (the runbook then tells the operator
    // to keep OLD_ENCRYPTION_KEY set, indefinitely).
    creds.set("cred_external", {
      id: "cred_external",
      tenantId: "t1",
      provider: "google",
      ciphertext: "",
      iv: "",
      authTag: "",
      keyVersion: 0,
    });

    const res = await rotateMasterKey({ master: chain });

    expect(res.failures).toEqual([]);
    expect(res.credentialsConverged).toBe(1); // only the legacy v2 row
    // Untouched — still the external sentinel, no rewrite attempted.
    expect(creds.get("cred_external")).toMatchObject({
      keyVersion: 0,
      ciphertext: "",
    });
  });
});
