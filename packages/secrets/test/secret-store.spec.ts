import { randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const creds = new Map<string, any>();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
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
      deleteMany: async ({ where }: any) => {
        for (const [k, r] of creds)
          if (
            r.tenantId === where.tenantId &&
            r.environmentId === where.environmentId &&
            r.provider === where.provider
          )
            creds.delete(k);
        return { count: 1 };
      },
    },
  }),
}));

import { SecretStore } from "../src/secret-store";

const SECRET = "oauth-refresh-token-value-xyz";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
});
beforeEach(() => creds.clear());

describe("SecretStore", () => {
  it("stores ciphertext (not plaintext) and round-trips via get", async () => {
    const store = new SecretStore();
    await store.put("t1", "e1", "conn:c1", SECRET);

    const row = creds.get("t1::e1::conn:c1");
    expect(row.ciphertext).toBeTypeOf("string");
    expect(JSON.stringify(row)).not.toContain(SECRET); // encrypted at rest

    expect(await store.get("t1", "e1", "conn:c1")).toBe(SECRET);
  });

  it("returns null for an unknown key, and remove deletes", async () => {
    const store = new SecretStore();
    expect(await store.get("t1", "e1", "conn:missing")).toBeNull();
    await store.put("t1", "e1", "conn:c1", SECRET);
    await store.remove("t1", "e1", "conn:c1");
    expect(await store.get("t1", "e1", "conn:c1")).toBeNull();
  });
});
