import { randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const creds = new Map<string, any>();
const tenantKeys = new Map<string, any>();
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
