import { beforeEach, describe, expect, it, vi } from "vitest";

// SecretStore builds an AES encryptor at construction (the prune path doesn't use
// it, but the constructor requires the key). A throwaway test key.
process.env.ENCRYPTION_KEY ??= "00".repeat(32);

const deleteMany = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ tenantCredential: { deleteMany } }),
}));

import { SecretStore } from "../src/secret-store";

beforeEach(() => deleteMany.mockReset().mockResolvedValue({ count: 3 }));

describe("SecretStore.prunePrefixOlderThan (audit S-5)", () => {
  it("deletes prefix-matched rows older than the window and returns the count", async () => {
    const n = await new SecretStore().prunePrefixOlderThan(
      "t-1",
      "e1",
      "oauth-state:",
      600_000,
    );
    expect(n).toBe(3);
    const where = deleteMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe("t-1");
    expect(where.environmentId).toBe("e1");
    expect(where.provider).toEqual({ startsWith: "oauth-state:" });
    // createdAt cutoff is ~now - window (decryption-free age prune)
    expect(where.createdAt.lt).toBeInstanceOf(Date);
    expect(Date.now() - where.createdAt.lt.getTime()).toBeGreaterThanOrEqual(
      600_000 - 1000,
    );
  });
});
