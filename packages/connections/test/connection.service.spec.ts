import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretStore } from "@naary/secrets";

// @naary/db mock backs connection.* (this is transformed src, so the mock applies).
const conns = new Map<string, any>();
let seq = 0;
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    connection: {
      create: async ({ data }: any) => {
        const row = {
          id: `c${++seq}`,
          status: "connected",
          scopes: [],
          createdAt: new Date(),
          ...data,
        };
        conns.set(row.id, row);
        return row;
      },
      findMany: async ({ where }: any) =>
        [...conns.values()].filter(
          (r) =>
            r.tenantId === where.tenantId &&
            r.environmentId === where.environmentId,
        ),
      findFirst: async ({ where }: any) =>
        [...conns.values()].find(
          (r) => r.id === where.id && r.tenantId === where.tenantId,
        ) ?? null,
      deleteMany: async ({ where }: any) => {
        for (const [k, r] of conns)
          if (r.id === where.id && r.tenantId === where.tenantId)
            conns.delete(k);
        return { count: 1 };
      },
      update: async ({ where, data }: any) => {
        const r = conns.get(where.id);
        Object.assign(r, data);
        return r;
      },
    },
  }),
}));

import {
  ConnectionService,
  MissingConnectionTokenError,
  resolveAuthHeader,
} from "../src/index";

// In-memory stand-in for the encrypted SecretStore (its encryption is tested in
// @naary/secrets). Injected so this test doesn't reach the real @naary/db.
const secretMap = new Map<string, string>();
const fakeStore = {
  put: async (t: string, e: string, k: string, v: string) =>
    void secretMap.set(`${t}::${e}::${k}`, v),
  get: async (t: string, e: string, k: string) =>
    secretMap.get(`${t}::${e}::${k}`) ?? null,
  remove: async (t: string, e: string, k: string) =>
    void secretMap.delete(`${t}::${e}::${k}`),
  // Delete the `conn:<id>` secret across ALL envs (the key is globally unique).
  removeAllEnvs: async (t: string, k: string) => {
    for (const mapKey of [...secretMap.keys()]) {
      const [mt, , ...rest] = mapKey.split("::");
      if (mt === t && rest.join("::") === k) secretMap.delete(mapKey);
    }
  },
} as unknown as SecretStore;

const PAT = "glpat-secret-token-value-123";

beforeEach(() => {
  conns.clear();
  secretMap.clear();
  seq = 0;
});

describe("ConnectionService", () => {
  it("persists the token via the secret store and never exposes it in the view", async () => {
    const svc = new ConnectionService(fakeStore);
    const view = await svc.create("t1", "e1", {
      type: "atlassian",
      label: "jira",
      serverUrl: "https://mcp.atlassian.com/v1/mcp",
      authMode: "api_token",
      token: PAT,
    });

    expect(view.authMode).toBe("api_token");
    expect(JSON.stringify(view)).not.toContain(PAT); // view carries no token
    expect(secretMap.get(`t1::e1::conn:${view.id}`)).toBe(PAT); // stored via the store
  });

  it("resolves a PAT connection to a Bearer header (B1)", async () => {
    const svc = new ConnectionService(fakeStore);
    const view = await svc.create("t1", "e1", {
      type: "github",
      label: "gh",
      serverUrl: "https://api.githubcopilot.com/mcp/",
      authMode: "pat",
      token: PAT,
    });

    const header = await resolveAuthHeader("t1", view.id, {
      connections: svc,
      store: fakeStore,
    });
    expect(header.Authorization).toBe(`Bearer ${PAT}`);
  });

  it("list omits tokens", async () => {
    const svc = new ConnectionService(fakeStore);
    await svc.create("t1", "e1", {
      type: "github",
      label: "gh",
      serverUrl: "u",
      authMode: "pat",
      token: PAT,
    });
    const list = await svc.list("t1", "e1");
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(PAT);
  });

  it("credentialLast4Map exposes only the last 4 chars of a bearer secret, never the full token (#471)", async () => {
    const svc = new ConnectionService(fakeStore);
    const bearer = await svc.create("t1", "e1", {
      type: "github",
      label: "gh",
      serverUrl: "u",
      authMode: "pat",
      token: PAT, // "glpat-secret-token-value-123"
    });

    const map = await svc.credentialLast4Map("t1", "e1");

    expect(map[bearer.id]).toBe(PAT.slice(-4)); // "-123"
    expect(map[bearer.id]).toHaveLength(4);
    // The full secret must NEVER appear in the returned metadata.
    expect(JSON.stringify(map)).not.toContain(PAT);
    expect(JSON.stringify(map)).not.toContain("glpat-secret-token-value");
  });

  it("credentialLast4Map returns null for connection-string / tokenless / short secrets (#471)", async () => {
    const svc = new ConnectionService(fakeStore);
    // A DB connection string — its tail is a URL fragment, not a credential → null (no decrypt hint).
    const dsn = await svc.create("t1", "e1", {
      type: "postgres",
      label: "db",
      serverUrl: "db.internal:5432",
      authMode: "connection_string",
      token: "postgres://user:pass@db.internal:5432/app?sslmode=require",
    });
    // OAuth stores a JSON grant blob under conn:<id>, not a raw token — excluded, so even WITH a
    // stored value the last-4 is null (never surface `…"}` JSON punctuation).
    const oauth = await svc.create("t1", "e1", {
      type: "custom",
      label: "oauth",
      serverUrl: "u",
      authMode: "oauth",
      token: JSON.stringify({
        refreshToken: "rt-secret-abcd",
        accessToken: "at",
      }),
    });
    // github_app stores `{ installationId }` — a non-secret id blob → also excluded.
    const app = await svc.create("t1", "e1", {
      type: "github",
      label: "gh-app",
      serverUrl: "u",
      authMode: "github_app",
      token: JSON.stringify({ installationId: "12345678" }),
    });
    // A bearer connection whose secret is shorter than 4 chars → null (don't reveal a whole secret).
    const short = await svc.create("t1", "e1", {
      type: "custom",
      label: "short",
      serverUrl: "u",
      authMode: "api_token",
      token: "ab",
    });

    const map = await svc.credentialLast4Map("t1", "e1");

    expect(map[dsn.id]).toBeNull();
    expect(map[oauth.id]).toBeNull();
    expect(map[app.id]).toBeNull();
    expect(map[short.id]).toBeNull();
    // Neither the connection string nor the JSON grants leak through the metadata at all.
    expect(JSON.stringify(map)).not.toContain("sslmode=require");
    expect(JSON.stringify(map)).not.toContain("pass");
    expect(JSON.stringify(map)).not.toContain("rt-secret-abcd");
    expect(JSON.stringify(map)).not.toContain("12345678");
  });

  it("throws MissingConnectionTokenError when a PAT connection has no token", async () => {
    const svc = new ConnectionService(fakeStore);
    const view = await svc.create("t1", "e1", {
      type: "custom",
      label: "x",
      serverUrl: "u",
      authMode: "api_token",
    });
    await expect(
      resolveAuthHeader("t1", view.id, { connections: svc, store: fakeStore }),
    ).rejects.toBeInstanceOf(MissingConnectionTokenError);
  });

  it("remove deletes the connection row AND its stored secret", async () => {
    const svc = new ConnectionService(fakeStore);
    const view = await svc.create("t1", "e1", {
      type: "github",
      label: "gh",
      serverUrl: "u",
      authMode: "pat",
      token: PAT,
    });
    expect(secretMap.get(`t1::e1::conn:${view.id}`)).toBe(PAT);

    await svc.remove("t1", view.id);
    expect(await svc.list("t1", "e1")).toHaveLength(0);
    expect(secretMap.get(`t1::e1::conn:${view.id}`)).toBeUndefined();
  });

  it("remove purges the secret even when the connection row is already gone (no orphan)", async () => {
    const svc = new ConnectionService(fakeStore);
    const view = await svc.create("t1", "e1", {
      type: "github",
      label: "gh",
      serverUrl: "u",
      authMode: "pat",
      token: PAT,
    });
    // Simulate a prior partial failure: the row was deleted but the secret lingered.
    conns.clear();
    expect(secretMap.get(`t1::e1::conn:${view.id}`)).toBe(PAT); // orphaned secret

    // remove must still purge it env-agnostically (not skip because the row is missing).
    await svc.remove("t1", view.id);
    expect(secretMap.get(`t1::e1::conn:${view.id}`)).toBeUndefined();
  });
});
