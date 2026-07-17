import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory TenantKey table. `create` enforces the primary key like Postgres would,
// so the mint-race path (unique violation → re-read the winner) is exercised for real.
const rows = new Map<string, Record<string, unknown>>();
const createSpy = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    tenantKey: {
      findUnique: async ({ where }: { where: { tenantId: string } }) =>
        rows.get(where.tenantId) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createSpy(data);
        const tenantId = data.tenantId as string;
        if (rows.has(tenantId))
          throw Object.assign(new Error("unique constraint"), {
            code: "P2002",
          });
        rows.set(tenantId, data);
        return data;
      },
    },
  }),
}));

import { AesGcmKeyEncryptor } from "../src/crypto";
import { TENANT_KEY_VERSION, TenantKeyService } from "../src/tenant-keys";

const master = new AesGcmKeyEncryptor(randomBytes(32).toString("hex"));
const SECRET = "sk-provider-key-value-123456";

beforeEach(() => {
  rows.clear();
  createSpy.mockClear();
});

describe("TenantKeyService (per-tenant envelope encryption)", () => {
  it("mints a wrapped DEK on first use and round-trips at keyVersion 3", async () => {
    const svc = new TenantKeyService({ master });

    const enc = await svc.encrypt("t1", SECRET, "t1:anthropic");
    expect(enc.keyVersion).toBe(TENANT_KEY_VERSION);
    expect(enc.ciphertext).not.toContain(SECRET);

    // A TenantKey row exists, and it is NOT the raw DEK: it must unwrap under the
    // master with the dek:<tenantId> AAD (i.e., it is envelope-wrapped).
    const row = rows.get("t1")!;
    const dekHex = master.decrypt(
      {
        ciphertext: row.ciphertext as string,
        iv: row.iv as string,
        authTag: row.authTag as string,
        keyVersion: row.keyVersion as number,
      },
      "dek:t1",
    );
    expect(dekHex).toMatch(/^[0-9a-f]{64}$/); // a real 32-byte key, hex-encoded

    expect(await svc.decrypt("t1", enc, "t1:anthropic")).toBe(SECRET);
  });

  it("v3 ciphertext is NOT decryptable with the master key (the DEK is a real boundary)", async () => {
    const svc = new TenantKeyService({ master });
    const enc = await svc.encrypt("t1", SECRET, "t1:anthropic");
    expect(() => master.decrypt(enc, "t1:anthropic")).toThrow();
  });

  it("different tenants get DIFFERENT DEKs (cross-tenant isolation)", async () => {
    const svc = new TenantKeyService({ master });
    const a = await svc.encrypt("t1", SECRET, "x");
    // t2's service (fresh cache, same DB) must not be able to read t1's ciphertext
    // even under the same AAD — its DEK is different.
    await svc.encrypt("t2", SECRET, "x");
    await expect(svc.decrypt("t2", a, "x")).rejects.toThrow();
    expect(rows.size).toBe(2);
  });

  it("decrypts LEGACY v1/v2 payloads with the master key — no DEK minted", async () => {
    const svc = new TenantKeyService({ master });
    const v2 = master.encrypt(SECRET, "t1:anthropic"); // keyVersion 2
    const v1 = master.encrypt(SECRET); // keyVersion 1, no AAD

    expect(await svc.decrypt("t1", v2, "t1:anthropic")).toBe(SECRET);
    expect(await svc.decrypt("t1", v1, "t1:anthropic")).toBe(SECRET);
    expect(rows.size).toBe(0); // reading legacy rows must not mint DEKs
  });

  it("caches the DEK: one row read + one mint per tenant per instance", async () => {
    const svc = new TenantKeyService({ master });
    await svc.encrypt("t1", "a", "aad");
    await svc.encrypt("t1", "b", "aad");
    await svc.encrypt("t1", "c", "aad");
    expect(createSpy).toHaveBeenCalledOnce();
  });

  it("a concurrent mint race converges on the WINNER's DEK (unique violation → re-read)", async () => {
    // Two independent instances (≈ two processes) race to mint t1's DEK.
    const a = new TenantKeyService({ master });
    const b = new TenantKeyService({ master });
    const encA = await a.encrypt("t1", SECRET, "aad"); // a wins the mint
    const encB = await b.encrypt("t1", SECRET, "aad"); // b's create hits the PK, re-reads a's DEK

    expect(rows.size).toBe(1);
    // Both ciphertexts decrypt through EITHER instance — same underlying DEK.
    expect(await b.decrypt("t1", encA, "aad")).toBe(SECRET);
    expect(await a.decrypt("t1", encB, "aad")).toBe(SECRET);
  });

  it("a TenantKey row swapped between tenants fails to unwrap (AAD binding)", async () => {
    const svc = new TenantKeyService({ master });
    await svc.encrypt("t1", SECRET, "aad");
    // Attacker with DB write access copies t1's wrapped DEK over t2's slot.
    const stolen = { ...rows.get("t1")!, tenantId: "t2" };
    rows.set("t2", stolen);
    const fresh = new TenantKeyService({ master }); // no cache — forced to unwrap
    await expect(fresh.encrypt("t2", "x", "aad")).rejects.toThrow();
  });

  it("crypto-shredding: deleting the TenantKey row makes v3 ciphertexts unreadable", async () => {
    const svc = new TenantKeyService({ master });
    const enc = await svc.encrypt("t1", SECRET, "aad");
    rows.delete("t1"); // tenant erasure
    const fresh = new TenantKeyService({ master });
    // A NEW DEK gets minted for the tenant id, and the old ciphertext no longer decrypts.
    await expect(fresh.decrypt("t1", enc, "aad")).rejects.toThrow();
  });
});
