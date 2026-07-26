import { randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const creds = new Map<string, any>();
const tenantKeys = new Map<string, any>();
// In-memory TenantSecret table (tenant-wide/global secrets, #459), keyed `${tenantId}::${key}`.
const globals = new Map<string, any>();
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
    tenantSecret: {
      upsert: async ({ where, create, update }: any) => {
        const w = where.tenantId_key;
        const k = `${w.tenantId}::${w.key}`;
        const row = { ...(globals.get(k) ?? create), ...update };
        globals.set(k, row);
        return row;
      },
      findUnique: async ({ where }: any) => {
        const w = where.tenantId_key;
        return globals.get(`${w.tenantId}::${w.key}`) ?? null;
      },
      findMany: async ({ where, orderBy }: any) => {
        const rows = [...globals.values()].filter(
          (r) =>
            r.tenantId === where.tenantId &&
            (where.key?.startsWith === undefined ||
              String(r.key).startsWith(where.key.startsWith)),
        );
        if (orderBy?.key === "asc")
          rows.sort((a, b) => String(a.key).localeCompare(String(b.key)));
        return rows.map((r) => ({ key: r.key }));
      },
      deleteMany: async ({ where }: any) => {
        let count = 0;
        for (const [k, r] of globals)
          if (
            r.tenantId === where.tenantId &&
            (where.key === undefined || r.key === where.key)
          ) {
            globals.delete(k);
            count++;
          }
        return { count };
      },
    },
    tenantCredential: {
      // Enforces the (tenantId, environmentId, provider) unique constraint, which is what
      // `putIfAbsent` relies on to be atomic (#455 replay defence).
      create: async ({ data }: any) => {
        const k = `${data.tenantId}::${data.environmentId}::${data.provider}`;
        if (creds.has(k)) {
          throw Object.assign(new Error("unique constraint"), { code: "P2002" });
        }
        creds.set(k, data);
        return data;
      },
      upsert: async ({ where, create, update }: any) => {
        const w = where.tenantId_environmentId_provider;
        const k = `${w.tenantId}::${w.environmentId}::${w.provider}`;
        const row = { ...(creds.get(k) ?? create), ...update };
        creds.set(k, row);
        return row;
      },
      findUnique: async ({ where }: any) => {
        const w = where.tenantId_environmentId_provider;
        return (
          creds.get(`${w.tenantId}::${w.environmentId}::${w.provider}`) ?? null
        );
      },
      // Match only the fields PRESENT in `where` — removeAllEnvs omits environmentId (delete across
      // all envs), so an unconditional environmentId comparison would wrongly match nothing.
      deleteMany: async ({ where }: any) => {
        let count = 0;
        for (const [k, r] of creds)
          if (
            r.tenantId === where.tenantId &&
            (where.environmentId === undefined ||
              r.environmentId === where.environmentId) &&
            (where.provider === undefined || r.provider === where.provider)
          ) {
            creds.delete(k);
            count++;
          }
        return { count };
      },
    },
  }),
}));

import { SecretStore } from "../src/secret-store";
import { TenantKeyService } from "../src/tenant-keys";

// A FRESH envelope service per store: the default SecretStore() shares the
// process-wide TenantKeyService, whose DEK cache would outlive the per-test
// reset of the in-memory tenantKey table and make tests order-dependent.
const makeStore = () => new SecretStore(undefined, new TenantKeyService());

const SECRET = "oauth-refresh-token-value-xyz";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
});
beforeEach(() => {
  creds.clear();
  tenantKeys.clear();
  globals.clear();
});

describe("SecretStore", () => {
  it("stores ciphertext (not plaintext) and round-trips via get", async () => {
    const store = makeStore();
    await store.put("t1", "e1", "conn:c1", SECRET);

    const row = creds.get("t1::e1::conn:c1");
    expect(row.ciphertext).toBeTypeOf("string");
    expect(JSON.stringify(row)).not.toContain(SECRET); // encrypted at rest

    expect(await store.get("t1", "e1", "conn:c1")).toBe(SECRET);
  });

  it("returns null for an unknown key, and remove deletes", async () => {
    const store = makeStore();
    expect(await store.get("t1", "e1", "conn:missing")).toBeNull();
    await store.put("t1", "e1", "conn:c1", SECRET);
    await store.remove("t1", "e1", "conn:c1");
    expect(await store.get("t1", "e1", "conn:c1")).toBeNull();
  });

  it("remove is env-SCOPED — only the named env's row goes", async () => {
    const store = makeStore();
    await store.put("t1", "e1", "conn:c1", SECRET);
    await store.put("t1", "e2", "conn:c1", SECRET);
    await store.remove("t1", "e1", "conn:c1");
    expect(await store.get("t1", "e1", "conn:c1")).toBeNull();
    expect(await store.get("t1", "e2", "conn:c1")).toBe(SECRET); // other env untouched
  });

  it("removeAllEnvs deletes the key across EVERY env (not filtered by environmentId)", async () => {
    const store = makeStore();
    // Same globally-unique key present in two envs; removeAllEnvs must purge both. A regression that
    // re-added environmentId to the filter would leave the other env's row (this guards that).
    await store.put("t1", "e1", "conn:c1", SECRET);
    await store.put("t1", "e2", "conn:c1", SECRET);
    // A different tenant's identical key must survive (tenant-scoped).
    await store.put("t2", "e1", "conn:c1", SECRET);

    await store.removeAllEnvs("t1", "conn:c1");

    expect(await store.get("t1", "e1", "conn:c1")).toBeNull();
    expect(await store.get("t1", "e2", "conn:c1")).toBeNull();
    expect(await store.get("t2", "e1", "conn:c1")).toBe(SECRET); // other tenant untouched
  });
});

describe("SecretStore — tenant-wide (global) secrets (#459)", () => {
  it("putGlobal stores ciphertext (not plaintext) and getGlobal round-trips; env-independent", async () => {
    const store = makeStore();
    await store.putGlobal("t1", "secret:API_KEY", SECRET);

    const row = globals.get("t1::secret:API_KEY");
    expect(row.ciphertext).toBeTypeOf("string");
    expect(JSON.stringify(row)).not.toContain(SECRET); // encrypted at rest

    expect(await store.getGlobal("t1", "secret:API_KEY")).toBe(SECRET);
    // No env dimension: the same call resolves regardless of any environment.
    expect(await store.getGlobal("t1", "secret:MISSING")).toBeNull();
  });

  it("listGlobalKeys strips the prefix, sorts, and NEVER returns values", async () => {
    const store = makeStore();
    await store.putGlobal("t1", "secret:ZED", "z-value");
    await store.putGlobal("t1", "secret:ALPHA", "a-value");
    await store.putGlobal("t1", "conn:c1", "not-a-secret"); // different prefix, excluded
    await store.putGlobal("t2", "secret:OTHER", "other-tenant"); // other tenant excluded

    const names = await store.listGlobalKeys("t1", "secret:");

    expect(names).toEqual(["ALPHA", "ZED"]); // prefix stripped + sorted
    expect(JSON.stringify(names)).not.toContain("z-value");
    expect(JSON.stringify(names)).not.toContain("a-value");
  });

  it("removeGlobal deletes the tenant-wide secret (idempotent)", async () => {
    const store = makeStore();
    await store.putGlobal("t1", "secret:API_KEY", SECRET);
    await store.removeGlobal("t1", "secret:API_KEY");
    expect(await store.getGlobal("t1", "secret:API_KEY")).toBeNull();
    await store.removeGlobal("t1", "secret:API_KEY"); // no-op, must not throw
  });

  it("getWithGlobalFallback: ENV value WINS when both exist (per-env override precedence)", async () => {
    const store = makeStore();
    await store.put("t1", "e1", "secret:TOKEN", "ENV_VALUE");
    await store.putGlobal("t1", "secret:TOKEN", "GLOBAL_VALUE");

    expect(await store.getWithGlobalFallback("t1", "e1", "secret:TOKEN")).toBe(
      "ENV_VALUE",
    );
  });

  it("getWithGlobalFallback: GLOBAL value applies when only the global exists", async () => {
    const store = makeStore();
    await store.putGlobal("t1", "secret:TOKEN", "GLOBAL_VALUE");

    expect(await store.getWithGlobalFallback("t1", "e1", "secret:TOKEN")).toBe(
      "GLOBAL_VALUE",
    );
    // Another env with no override also falls back to the same global value.
    expect(await store.getWithGlobalFallback("t1", "e2", "secret:TOKEN")).toBe(
      "GLOBAL_VALUE",
    );
  });

  it("getWithGlobalFallback: null when NEITHER an env nor a global secret exists", async () => {
    const store = makeStore();
    expect(
      await store.getWithGlobalFallback("t1", "e1", "secret:NOPE"),
    ).toBeNull();
  });
});

describe("SecretStore.putIfAbsent — atomic single-use write (#455)", () => {
  it("the FIRST write wins and the value round-trips", async () => {
    const store = makeStore();
    await expect(
      store.putIfAbsent("t-1", "env-1", "saml:abc", "2026-07-25T00:00:00.000Z"),
    ).resolves.toBe(true);
    await expect(store.get("t-1", "env-1", "saml:abc")).resolves.toBe(
      "2026-07-25T00:00:00.000Z",
    );
  });

  it("a SECOND write for the same key returns false and does NOT overwrite", async () => {
    const store = makeStore();
    await store.putIfAbsent("t-1", "env-1", "saml:abc", "first");
    await expect(
      store.putIfAbsent("t-1", "env-1", "saml:abc", "second"),
    ).resolves.toBe(false);
    await expect(store.get("t-1", "env-1", "saml:abc")).resolves.toBe("first");
  });

  it("CONCURRENT writes: exactly one caller wins (the unique constraint decides)", async () => {
    const store = makeStore();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        store.putIfAbsent("t-1", "env-1", "saml:race", "x"),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("is per (tenant, env, key): the same key in another env/tenant still wins", async () => {
    const store = makeStore();
    await store.putIfAbsent("t-1", "env-1", "saml:abc", "a");
    await expect(
      store.putIfAbsent("t-1", "env-2", "saml:abc", "b"),
    ).resolves.toBe(true);
    await expect(
      store.putIfAbsent("t-2", "env-1", "saml:abc", "c"),
    ).resolves.toBe(true);
  });

  it("stores CIPHERTEXT, not the plaintext", async () => {
    const store = makeStore();
    await store.putIfAbsent("t-1", "env-1", "saml:abc", "PLAINTEXT-CANARY");
    const row = creds.get("t-1::env-1::saml:abc");
    expect(JSON.stringify(row)).not.toContain("PLAINTEXT-CANARY");
    expect(row.keyVersion).toBe(3);
  });
});
