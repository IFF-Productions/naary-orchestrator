import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory TenantCredential + TenantKey tables (same shape as credentials.service.spec.ts).
type Row = Record<string, unknown> & {
  tenantId: string;
  environmentId: string;
  provider: string;
};
const rows = new Map<string, Row>();
const tenantKeys = new Map<string, Record<string, unknown>>();
const rk = (t: string, e: string, p: string) => `${t}::${e}::${p}`;

vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    tenantKey: {
      findUnique: async ({ where }: any) =>
        tenantKeys.get(where.tenantId) ?? null,
      create: async ({ data }: any) => {
        tenantKeys.set(data.tenantId, data);
        return data;
      },
    },
    tenantCredential: {
      upsert: async ({ where, create, update }: any) => {
        const w = where.tenantId_environmentId_provider;
        const k = rk(w.tenantId, w.environmentId, w.provider);
        const existing = rows.get(k);
        const row = {
          id: existing?.id ?? `cred_${rows.size + 1}`,
          ...(existing ?? create),
          ...update,
        };
        rows.set(k, row as Row);
        return row;
      },
      findUnique: async ({ where }: any) => {
        const w = where.tenantId_environmentId_provider;
        return rows.get(rk(w.tenantId, w.environmentId, w.provider)) ?? null;
      },
      deleteMany: async ({ where }: any) => {
        let count = 0;
        for (const [k, r] of rows) {
          if (
            r.tenantId === where.tenantId &&
            r.environmentId === where.environmentId &&
            r.provider === where.provider
          ) {
            rows.delete(k);
            count++;
          }
        }
        return { count };
      },
    },
  }),
}));

import { AesGcmKeyEncryptor } from "../src/crypto";
import {
  CredentialsService,
  MissingCredentialError,
} from "../src/credentials.service";
import { DbSecretProvider, EXTERNAL_KEY_VERSION } from "../src/secret-provider";
import { TenantKeyService } from "../src/tenant-keys";
import { VaultSecretProvider } from "../src/vault-secret-provider";
import { stubVaultFetch } from "./secret-provider.contract.spec";

const TENANT = "t-1";
const ENV = "env-1";
/** The canary. Deliberately NOT shaped like a real provider key (the repo's pre-commit
 *  hook blocks key-shaped literals in source); what matters is that this exact string
 *  never appears anywhere it shouldn't. */
const KEY = "CANARY-provider-key-value";

const dbProvider = () =>
  new DbSecretProvider({
    tenantKeys: new TenantKeyService({
      master: new AesGcmKeyEncryptor(randomBytes(32).toString("hex")),
    }),
  });

/** CredentialsService wired to a Vault provider whose HTTP layer is stubbed. NO REAL VAULT
 *  OR AWS SECRETS MANAGER INSTANCE IS CONTACTED IN THIS SUITE. */
function withVault(opts?: { valid?: boolean; status?: number }) {
  const { fetch, kv } = stubVaultFetch();
  const failing = opts?.status;
  const fetchImpl = failing
    ? async () => ({
        ok: false,
        status: failing,
        json: async () => ({
          errors: ["permission denied for token vault-token-CANARY"],
        }),
        text: async () => "permission denied",
      })
    : fetch;
  const fallback = dbProvider();
  const provider = new VaultSecretProvider({
    addr: "https://vault.test",
    token: "vault-token-CANARY",
    fetchImpl: fetchImpl as never,
    fallback,
  });
  const svc = new CredentialsService({
    secretProvider: provider,
    validate: async () => opts?.valid ?? true,
  });
  return { svc, kv, fallback, provider };
}

beforeEach(() => {
  rows.clear();
  tenantKeys.clear();
});

describe("CredentialsService with an external SecretProvider (#458)", () => {
  it("stores material in the external store and only a keyVersion-0 index row in Postgres", async () => {
    const { svc, kv } = withVault();
    const res = await svc.saveCredential(TENANT, ENV, "anthropic", KEY);

    // The index row: metadata + the sentinel. NO material anywhere in it.
    const row = rows.get(rk(TENANT, ENV, "anthropic"))!;
    expect(row.keyVersion).toBe(EXTERNAL_KEY_VERSION);
    expect(row.ciphertext).toBe("");
    expect(row.iv).toBe("");
    expect(row.authTag).toBe("");
    expect(row.isValid).toBe(true);
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(JSON.stringify(row)).not.toContain("CANARY");

    // …and the material really did go to the external store.
    expect([...kv.values()]).toContain(KEY);
    expect([...kv.keys()]).toEqual(["naary/t-1/env-1/anthropic"]);

    // The API response is metadata only (unchanged contract).
    expect(res).toEqual({ id: row.id, provider: "anthropic", isValid: true });
    expect(JSON.stringify(res)).not.toContain("CANARY");
  });

  it("in-activity resolution is unchanged: same signature, returns the plaintext", async () => {
    const { svc } = withVault();
    await svc.saveCredential(TENANT, ENV, "anthropic", KEY);
    await expect(svc.getDecryptedKey(TENANT, ENV, "anthropic")).resolves.toBe(
      KEY,
    );
  });

  it("still gates on isValid (a rejected key never resolves)", async () => {
    const { svc } = withVault({ valid: false });
    await svc.saveCredential(TENANT, ENV, "anthropic", KEY);
    await expect(svc.getDecryptedKey(TENANT, ENV, "anthropic")).rejects.toThrow(
      MissingCredentialError,
    );
  });

  it("coexists with pre-existing DB rows: a keyVersion-3 row resolves after the flip", async () => {
    const { svc, fallback } = withVault();
    // Simulate a row written BEFORE the operator set SECRET_PROVIDER=vault.
    const legacy = await fallback.put(
      { tenantId: TENANT, environmentId: ENV, provider: "openai" },
      "LEGACY-DB-ROW-value",
    );
    rows.set(rk(TENANT, ENV, "openai"), {
      id: "cred_legacy",
      tenantId: TENANT,
      environmentId: ENV,
      provider: "openai",
      ...legacy,
      isValid: true,
    } as Row);
    await expect(svc.getDecryptedKey(TENANT, ENV, "openai")).resolves.toBe(
      "LEGACY-DB-ROW-value",
    );
  });

  it("deleteCredential removes BOTH the index row and the external material", async () => {
    const { svc, kv } = withVault();
    await svc.saveCredential(TENANT, ENV, "anthropic", KEY);
    expect(kv.size).toBe(1);
    await svc.deleteCredential(TENANT, ENV, "anthropic");
    expect(rows.size).toBe(0);
    expect(kv.size).toBe(0); // no orphaned live secret left in the external store
    await expect(svc.getDecryptedKey(TENANT, ENV, "anthropic")).rejects.toThrow(
      MissingCredentialError,
    );
  });

  it("the default provider (no config) is unchanged: writes keyVersion 3, not 0", async () => {
    const svc = new CredentialsService({
      encryptor: new AesGcmKeyEncryptor(randomBytes(32).toString("hex")),
      validate: async () => true,
    });
    await svc.saveCredential(TENANT, ENV, "anthropic", KEY);
    const row = rows.get(rk(TENANT, ENV, "anthropic"))!;
    expect(row.keyVersion).toBe(3);
    expect(String(row.ciphertext).length).toBeGreaterThan(0);
    expect(JSON.stringify(row)).not.toContain(KEY);
    await expect(svc.getDecryptedKey(TENANT, ENV, "anthropic")).resolves.toBe(
      KEY,
    );
  });
});

/**
 * Tier-1 §4 regression guard: the material must not appear in anything that crosses the
 * Temporal boundary (activity input/output — i.e. workflow args + event history) or in
 * logs, for EITHER provider. Modelled on the real activity shape: Temporal serializes an
 * activity's ARGUMENTS and its RETURN VALUE into history; the key exists only as a local.
 */
describe("secret never crosses the Temporal boundary or reaches logs (#458)", () => {
  const runActivityLike = async (
    svc: CredentialsService,
    // exactly what a workflow may pass (Tier-1 §4: ids only, never material)
    input: {
      tenantId: string;
      environmentId: string;
      provider: string;
      nodeId: string;
    },
    logs: string[],
  ) => {
    const record = (msg: string, meta?: Record<string, unknown>) =>
      logs.push(`${msg} ${JSON.stringify(meta ?? {})}`);
    record("resolving provider credential", {
      tenantId: input.tenantId,
      environmentId: input.environmentId,
      provider: input.provider,
      nodeId: input.nodeId,
    });
    const resolved = await svc.getDecryptedKey(
      input.tenantId,
      input.environmentId,
      input.provider,
    );
    // Used in memory only…
    const authHeaderLength = `Bearer ${resolved}`.length;
    record("provider call complete", { nodeId: input.nodeId, ok: true });
    // …and the activity RESULT (which lands in history) carries no material.
    return { nodeId: input.nodeId, tokens: 42, authHeaderLength };
  };

  for (const kind of ["db", "vault"] as const) {
    it(`${kind} provider: not in activity args, not in the activity result, not in logs`, async () => {
      const logs: string[] = [];
      const svc =
        kind === "vault"
          ? withVault().svc
          : new CredentialsService({
              encryptor: new AesGcmKeyEncryptor(
                randomBytes(32).toString("hex"),
              ),
              validate: async () => true,
            });
      await svc.saveCredential(TENANT, ENV, "anthropic", KEY);

      const input = {
        tenantId: TENANT,
        environmentId: ENV,
        provider: "anthropic",
        nodeId: "n1",
      };
      const result = await runActivityLike(svc, input, logs);

      // Workflow args (what the interpreter passes) …
      expect(JSON.stringify(input)).not.toContain("CANARY");
      // … the activity return value (event history) …
      expect(JSON.stringify(result)).not.toContain("CANARY");
      // … and every log line.
      expect(logs.join("\n")).not.toContain("CANARY");
      expect(logs.join("\n")).toContain("anthropic"); // the provider NAME is fine
    });
  }

  it("a failing external store surfaces a status-only error — no key, no store token", async () => {
    const broken = withVault({ status: 403 });
    rows.set(rk(TENANT, ENV, "anthropic"), {
      id: "cred_1",
      tenantId: TENANT,
      environmentId: ENV,
      provider: "anthropic",
      ciphertext: "",
      iv: "",
      authTag: "",
      keyVersion: EXTERNAL_KEY_VERSION,
      isValid: true,
    } as Row);
    const err = await broken.svc
      .getDecryptedKey(TENANT, ENV, "anthropic")
      .then(() => null)
      .catch((e: unknown) => e);
    const serialized = JSON.stringify({
      message: (err as Error).message,
      stack: (err as Error).stack,
      own: err,
      props: Object.getOwnPropertyNames(err).map(
        (k) => (err as unknown as Record<string, unknown>)[k],
      ),
    });
    expect(serialized).not.toContain("CANARY");
    expect(serialized).not.toContain("permission denied");
    expect((err as Error).message).toMatch(/status 403/);
  });
});
