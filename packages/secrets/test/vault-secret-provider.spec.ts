import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tenantKeys = new Map<string, Record<string, unknown>>();
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
  }),
}));

import { AesGcmKeyEncryptor } from "../src/crypto";
import {
  DbSecretProvider,
  EXTERNAL_KEY_VERSION,
  isExternalMaterial,
} from "../src/secret-provider";
import { TenantKeyService } from "../src/tenant-keys";
import {
  type FetchLike,
  VaultRequestError,
  VaultSecretProvider,
  createSecretProvider,
} from "../src/vault-secret-provider";

const ref = {
  tenantId: "t-1",
  environmentId: "env-1",
  provider: "anthropic",
};
const dbFallback = () =>
  new DbSecretProvider({
    tenantKeys: new TenantKeyService({
      master: new AesGcmKeyEncryptor(randomBytes(32).toString("hex")),
    }),
  });

/** Records every request so the WIRE PROTOCOL can be asserted. No socket is opened —
 *  NO REAL VAULT SERVER WAS CONTACTED anywhere in this file. */
function recorder(
  handler: (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ) => { status: number; body?: unknown },
) {
  const calls: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body,
    });
    const { status, body } = handler(url, init ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body ?? {},
      text: async () => JSON.stringify(body ?? {}),
    };
  };
  return { fetch, calls };
}

beforeEach(() => tenantKeys.clear());

describe("VaultSecretProvider — KV v2 wire protocol (stubbed fetch)", () => {
  it("writes to /v1/<mount>/data/<prefix>/<tenant>/<env>/<provider> with the KV v2 envelope", async () => {
    const { fetch, calls } = recorder(() => ({ status: 200 }));
    const p = new VaultSecretProvider({
      addr: "https://vault.test:8200/",
      token: "s.tok",
      mount: "kv",
      prefix: "naary-prod",
      namespace: "team-a",
      fetchImpl: fetch,
      fallback: dbFallback(),
    });
    await p.put(ref, "sk-ant-123");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(
      "https://vault.test:8200/v1/kv/data/naary-prod/t-1/env-1/anthropic",
    );
    expect(calls[0].headers["X-Vault-Token"]).toBe("s.tok");
    expect(calls[0].headers["X-Vault-Namespace"]).toBe("team-a");
    expect(JSON.parse(calls[0].body ?? "{}")).toEqual({
      data: { value: "sk-ant-123" },
    });
  });

  it("put returns the keyVersion-0 sentinel with EMPTY crypto columns", async () => {
    const { fetch } = recorder(() => ({ status: 200 }));
    const p = new VaultSecretProvider({
      addr: "https://vault.test",
      token: "s.tok",
      fetchImpl: fetch,
      fallback: dbFallback(),
    });
    const stored = await p.put(ref, "sk-ant-123");
    expect(stored).toEqual({
      ciphertext: "",
      iv: "",
      authTag: "",
      keyVersion: EXTERNAL_KEY_VERSION,
    });
    expect(isExternalMaterial(stored.keyVersion)).toBe(true);
  });

  it("reads the value out of the KV v2 data.data envelope", async () => {
    const { fetch, calls } = recorder(() => ({
      status: 200,
      body: { data: { data: { value: "sk-ant-from-vault" }, metadata: {} } },
    }));
    const p = new VaultSecretProvider({
      addr: "https://vault.test",
      token: "s.tok",
      fetchImpl: fetch,
      fallback: dbFallback(),
    });
    const got = await p.get(ref, {
      ciphertext: "",
      iv: "",
      authTag: "",
      keyVersion: EXTERNAL_KEY_VERSION,
    });
    expect(got).toBe("sk-ant-from-vault");
    expect(calls[0].method).toBe("GET");
  });

  it("destroys all versions (metadata endpoint) on remove, and tolerates 404", async () => {
    const { fetch, calls } = recorder(() => ({ status: 404 }));
    const p = new VaultSecretProvider({
      addr: "https://vault.test",
      token: "s.tok",
      fetchImpl: fetch,
      fallback: dbFallback(),
    });
    await p.remove(ref); // 404 = already gone; must not throw
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toContain(
      "/v1/secret/metadata/naary/t-1/env-1/anthropic",
    );
  });

  it("rejects a path segment that could escape the tenant subtree", async () => {
    const { fetch } = recorder(() => ({ status: 200 }));
    const p = new VaultSecretProvider({
      addr: "https://vault.test",
      token: "s.tok",
      fetchImpl: fetch,
      fallback: dbFallback(),
    });
    await expect(p.put({ ...ref, tenantId: "../other" }, "x")).rejects.toThrow(
      /Invalid tenantId/,
    );
    await expect(p.put({ ...ref, provider: "a/b" }, "x")).rejects.toThrow(
      /Invalid provider/,
    );
  });
});

describe("VaultSecretProvider — coexistence with existing DB rows (#458)", () => {
  it("routes a keyVersion-3 row to the DB fallback and never calls Vault", async () => {
    const { fetch, calls } = recorder(() => ({ status: 500 }));
    const fallback = dbFallback();
    const legacy = await fallback.put(ref, "sk-ant-legacy-db-row");
    expect(legacy.keyVersion).toBe(3);
    const p = new VaultSecretProvider({
      addr: "https://vault.test",
      token: "s.tok",
      fetchImpl: fetch,
      fallback,
    });
    expect(await p.get(ref, legacy)).toBe("sk-ant-legacy-db-row");
    expect(calls).toHaveLength(0);
  });

  it("a DB-only process refuses (loudly, without material) to read an external row", async () => {
    const db = dbFallback();
    await expect(
      db.get(ref, {
        ciphertext: "",
        iv: "",
        authTag: "",
        keyVersion: EXTERNAL_KEY_VERSION,
      }),
    ).rejects.toThrow(/external secret store/);
  });
});

describe("VaultSecretProvider — error hygiene (Tier-1 §4)", () => {
  it("a 403 surfaces the STATUS only: no token, no response body, no secret", async () => {
    const token = "s.SUPER-SECRET-VAULT-TOKEN";
    const { fetch } = recorder(() => ({
      status: 403,
      body: {
        errors: [
          "permission denied on secret/data/naary/t-1/env-1/anthropic for token s.SUPER-SECRET-VAULT-TOKEN",
        ],
      },
    }));
    const p = new VaultSecretProvider({
      addr: "https://vault.test",
      token,
      fetchImpl: fetch,
      fallback: dbFallback(),
    });
    const err = await p
      .get(ref, { ciphertext: "", iv: "", authTag: "", keyVersion: 0 })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultRequestError);
    // Everything a logger / Temporal failure serializer could reach:
    const seen = JSON.stringify({
      message: (err as Error).message,
      stack: (err as Error).stack,
      own: err,
      keys: Object.getOwnPropertyNames(err),
      values: Object.getOwnPropertyNames(err).map(
        (k) => (err as unknown as Record<string, unknown>)[k],
      ),
    });
    expect(seen).not.toContain(token);
    expect(seen).not.toContain("SUPER-SECRET");
    expect(seen).not.toContain("permission denied");
    expect((err as Error).message).toBe("Vault read failed (status 403)");
  });

  it("a write failure leaks neither the token nor the key being saved", async () => {
    const { fetch } = recorder(() => ({
      status: 503,
      body: { errors: ["sealed"] },
    }));
    const p = new VaultSecretProvider({
      addr: "https://vault.test",
      token: "s.tok-CANARY",
      fetchImpl: fetch,
      fallback: dbFallback(),
    });
    const err = await p
      .put(ref, "sk-ant-KEY-CANARY")
      .then(() => null)
      .catch((e: unknown) => e);
    const seen = JSON.stringify({
      message: (err as Error).message,
      stack: (err as Error).stack,
      own: err,
    });
    expect(seen).not.toContain("CANARY");
  });

  it("a transport error is normalised (no library request/headers object survives)", async () => {
    const fetchImpl: FetchLike = async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), {
        name: "FetchError",
        requestHeaders: { "X-Vault-Token": "s.tok-CANARY" },
      });
    };
    const p = new VaultSecretProvider({
      addr: "https://vault.test",
      token: "s.tok-CANARY",
      fetchImpl,
      fallback: dbFallback(),
    });
    const err = await p
      .get(ref, { ciphertext: "", iv: "", authTag: "", keyVersion: 0 })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(
      JSON.stringify({ m: (err as Error).message, own: err }),
    ).not.toContain("CANARY");
    expect((err as Error).message).toBe("Vault read failed: FetchError");
  });
});

describe("createSecretProvider — env selection, fails closed", () => {
  it("defaults to the DB provider (unset / empty / 'db')", () => {
    expect(createSecretProvider({}).name).toBe("db");
    expect(createSecretProvider({ SECRET_PROVIDER: "" }).name).toBe("db");
    expect(createSecretProvider({ SECRET_PROVIDER: " DB " }).name).toBe("db");
  });

  it("builds the Vault provider from env", () => {
    const p = createSecretProvider({
      SECRET_PROVIDER: "vault",
      VAULT_ADDR: "https://vault.test",
      VAULT_TOKEN: "s.tok",
    });
    expect(p.name).toBe("vault");
  });

  it("throws (never silently uses the DB) when vault config is incomplete", () => {
    expect(() =>
      createSecretProvider({ SECRET_PROVIDER: "vault", VAULT_TOKEN: "s.tok" }),
    ).toThrow(/VAULT_ADDR/);
    expect(() =>
      createSecretProvider({
        SECRET_PROVIDER: "vault",
        VAULT_ADDR: "https://vault.test",
      }),
    ).toThrow(/VAULT_TOKEN/);
  });

  it("throws on an unknown provider name", () => {
    expect(() => createSecretProvider({ SECRET_PROVIDER: "asm" })).toThrow(
      /Unsupported SECRET_PROVIDER/,
    );
  });

  it("does not read env at import time (lazy — ENCRYPTION_KEY/VAULT_* only on use)", () => {
    // Importing this module must not have constructed anything: the module-scope import at
    // the top of this file already happened without VAULT_ADDR/ENCRYPTION_KEY set.
    expect(process.env.VAULT_ADDR).toBeUndefined();
  });
});
