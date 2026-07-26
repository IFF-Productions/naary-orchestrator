import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory TenantKey table (wrapped per-tenant DEKs) so the DB provider exercises REAL
// envelope crypto. The DB provider touches no other table — the TenantCredential row is
// the CALLER's (CredentialsService's) concern, which is the point of the seam.
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
  }),
}));

import { AesGcmKeyEncryptor } from "../src/crypto";
import {
  type CredentialRef,
  DbSecretProvider,
  EXTERNAL_KEY_VERSION,
  type SecretProvider,
  type StoredMaterial,
} from "../src/secret-provider";
import { TenantKeyService } from "../src/tenant-keys";
import {
  type FetchLike,
  VaultSecretProvider,
} from "../src/vault-secret-provider";

const master = () => new AesGcmKeyEncryptor(randomBytes(32).toString("hex"));

/**
 * A ~25-line third implementation, present ONLY to prove the seam is genuinely pluggable:
 * anything satisfying `SecretProvider` drops in without touching `CredentialsService`.
 * This is what an AWS Secrets Manager adapter replaces its Map with.
 */
class FakeExternalProvider implements SecretProvider {
  readonly name = "fake";
  readonly store = new Map<string, string>();
  private k(ref: CredentialRef) {
    return `${ref.tenantId}/${ref.environmentId}/${ref.provider}`;
  }
  async put(ref: CredentialRef, plaintext: string): Promise<StoredMaterial> {
    this.store.set(this.k(ref), plaintext);
    return {
      ciphertext: "",
      iv: "",
      authTag: "",
      keyVersion: EXTERNAL_KEY_VERSION,
    };
  }
  async get(ref: CredentialRef): Promise<string> {
    const v = this.store.get(this.k(ref));
    if (v === undefined) throw new Error("absent");
    return v;
  }
  async remove(ref: CredentialRef): Promise<void> {
    this.store.delete(this.k(ref));
  }
}

/** An in-memory stand-in for Vault's KV v2 HTTP API. NO SOCKET IS OPENED and no real Vault
 *  server is contacted anywhere in this suite. */
export function stubVaultFetch(): {
  fetch: FetchLike;
  kv: Map<string, string>;
} {
  const kv = new Map<string, string>();
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    const dataPath = url.split("/v1/")[1] ?? "";
    const key = dataPath.replace(/^[^/]+\/(data|metadata)\//, "");
    const reply = (status: number, body: unknown = {}) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (method === "POST" || method === "PUT") {
      const parsed = JSON.parse(init?.body ?? "{}") as {
        data?: { value?: string };
      };
      kv.set(key, parsed.data?.value ?? "");
      return reply(200, { data: { version: 1 } });
    }
    if (method === "GET") {
      const v = kv.get(key);
      if (v === undefined) return reply(404, { errors: [] });
      return reply(200, { data: { data: { value: v }, metadata: {} } });
    }
    if (method === "DELETE") {
      const had = kv.delete(key);
      return reply(had ? 204 : 404, {});
    }
    return reply(405, {});
  };
  return { fetch, kv };
}

/**
 * The #458 provider contract. EVERY `SecretProvider` must pass this suite — it is the
 * acceptance harness for the next adapter (AWS Secrets Manager), not just documentation.
 */
function contract(name: string, make: () => SecretProvider) {
  describe(`SecretProvider contract — ${name}`, () => {
    const ref: CredentialRef = {
      tenantId: "t-1",
      environmentId: "env-1",
      provider: "anthropic",
    };

    it("1. put→get round-trips the exact plaintext (incl. unicode + long values)", async () => {
      const p = make();
      const secrets = [
        "sk-ant-api03-短い-키-🔐",
        "x".repeat(4096),
        "sk-with/slashes+and=padding",
      ];
      for (const [i, secret] of secrets.entries()) {
        const slot = { ...ref, provider: `p${i}` };
        const stored = await p.put(slot, secret);
        expect(await p.get(slot, stored)).toBe(secret);
      }
    });

    it("2. the StoredMaterial handed to the index row never contains the plaintext", async () => {
      const p = make();
      const secret = "sk-ant-SUPER-SECRET-VALUE";
      const stored = await p.put(ref, secret);
      expect(JSON.stringify(stored)).not.toContain(secret);
      expect(JSON.stringify(stored)).not.toContain("SUPER-SECRET");
      // and it is exactly the four at-rest columns — no smuggled extra field
      expect(Object.keys(stored).sort()).toEqual([
        "authTag",
        "ciphertext",
        "iv",
        "keyVersion",
      ]);
    });

    it("3. get of a never-written ref rejects (absence is never an empty string)", async () => {
      const p = make();
      const stored = await p.put(ref, "sk-present");
      await expect(
        p.get({ ...ref, provider: "never-written" }, stored),
      ).rejects.toThrow();
    });

    it("4. refs are isolated across tenant, env and provider", async () => {
      const p = make();
      const a = await p.put(ref, "secret-A");
      const b = await p.put({ ...ref, tenantId: "t-2" }, "secret-B");
      const c = await p.put({ ...ref, environmentId: "env-2" }, "secret-C");
      const d = await p.put({ ...ref, provider: "openai" }, "secret-D");
      expect(await p.get(ref, a)).toBe("secret-A");
      expect(await p.get({ ...ref, tenantId: "t-2" }, b)).toBe("secret-B");
      expect(await p.get({ ...ref, environmentId: "env-2" }, c)).toBe(
        "secret-C",
      );
      expect(await p.get({ ...ref, provider: "openai" }, d)).toBe("secret-D");
      // A row moved between slots must NOT resolve to the other slot's secret: the DB
      // provider fails the AAD check; an external provider is keyed by path so it either
      // rejects or returns that slot's own value — never tenant t-1's secret.
      const cross = await p
        .get({ ...ref, provider: "openai" }, a)
        .catch(() => "REJECTED");
      expect(cross).not.toBe("secret-A");
    });

    it("5. remove is idempotent and the secret is gone afterwards", async () => {
      const p = make();
      const stored = await p.put(ref, "secret-to-drop");
      await p.remove(ref);
      await p.remove(ref); // second time must not throw
      if (p.name !== "db") {
        // For the DB provider, deleting the index row IS the delete (remove is a no-op),
        // so only external providers can be asserted to have dropped the material.
        await expect(p.get(ref, stored)).rejects.toThrow();
      }
    });

    it("6. errors carry no plaintext (and no store access token)", async () => {
      const p = make();
      const secret = "sk-ant-LEAK-CANARY-0000";
      await p.put(ref, secret);
      const err = await p
        .get(
          { ...ref, provider: "absent-slot" },
          {
            ciphertext: "",
            iv: "",
            authTag: "",
            keyVersion: EXTERNAL_KEY_VERSION,
          },
        )
        .then(() => null)
        .catch((e: unknown) => e);
      const serialized = JSON.stringify({
        message: (err as Error)?.message,
        // structuredClone-ish: whatever a logger/Temporal serializer would see
        own: err,
        stack: (err as Error)?.stack,
      });
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("LEAK-CANARY");
      expect(serialized).not.toContain("vault-root-token");
    });
  });
}

beforeEach(() => {
  tenantKeys.clear();
});

contract(
  "DbSecretProvider (default)",
  () =>
    new DbSecretProvider({
      tenantKeys: new TenantKeyService({ master: master() }),
    }),
);

contract("VaultSecretProvider (stubbed HTTP)", () => {
  const { fetch } = stubVaultFetch();
  return new VaultSecretProvider({
    addr: "https://vault.test:8200",
    token: "vault-root-token",
    fetchImpl: fetch,
    fallback: new DbSecretProvider({
      tenantKeys: new TenantKeyService({ master: master() }),
    }),
  });
});

contract(
  "FakeExternalProvider (a third implementation)",
  () => new FakeExternalProvider(),
);
