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
        [...conns.values()].filter((r) => r.tenantId === where.tenantId),
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
  put: async (t: string, k: string, v: string) =>
    void secretMap.set(`${t}::${k}`, v),
  get: async (t: string, k: string) => secretMap.get(`${t}::${k}`) ?? null,
  remove: async (t: string, k: string) => void secretMap.delete(`${t}::${k}`),
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
    const view = await svc.create("t1", {
      type: "atlassian",
      label: "jira",
      serverUrl: "https://mcp.atlassian.com/v1/mcp",
      authMode: "api_token",
      token: PAT,
    });

    expect(view.authMode).toBe("api_token");
    expect(JSON.stringify(view)).not.toContain(PAT); // view carries no token
    expect(secretMap.get(`t1::conn:${view.id}`)).toBe(PAT); // stored via the store
  });

  it("resolves a PAT connection to a Bearer header (B1)", async () => {
    const svc = new ConnectionService(fakeStore);
    const view = await svc.create("t1", {
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
    await svc.create("t1", {
      type: "github",
      label: "gh",
      serverUrl: "u",
      authMode: "pat",
      token: PAT,
    });
    const list = await svc.list("t1");
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(PAT);
  });

  it("throws MissingConnectionTokenError when a PAT connection has no token", async () => {
    const svc = new ConnectionService(fakeStore);
    const view = await svc.create("t1", {
      type: "custom",
      label: "x",
      serverUrl: "u",
      authMode: "api_token",
    });
    await expect(
      resolveAuthHeader("t1", view.id, { connections: svc, store: fakeStore }),
    ).rejects.toBeInstanceOf(MissingConnectionTokenError);
  });
});
