import { beforeEach, describe, expect, it, vi } from "vitest";
import { NeedsReauthError } from "../src/errors";
import {
  __resetOAuthCaches,
  buildAuthorizeUrl,
  getOAuthAccessToken,
  type OAuthConfig,
} from "../src/oauth";
import { connectionSecretKey } from "../src/connection.service";

const CONN = "conn-1";
const baseCfg: OAuthConfig = {
  clientId: "client-abc",
  tokenEndpoint: "https://auth.example.com/token",
  resource: "https://mcp.atlassian.com/v1/mcp",
  refreshToken: "RT-original",
};

function fakeStore(cfg: OAuthConfig) {
  const put = vi.fn(async () => {});
  const prunePrefixOlderThan = vi.fn(async () => 0);
  return {
    store: {
      get: async () => JSON.stringify(cfg),
      put,
      remove: async () => {},
      prunePrefixOlderThan,
    } as never,
    put,
    prunePrefixOlderThan,
  };
}

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

beforeEach(() => __resetOAuthCaches());

describe("buildAuthorizeUrl", () => {
  it("includes PKCE S256, the resource param, and offline_access", () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizationEndpoint: "https://auth.example.com/authorize",
        clientId: "client-abc",
        redirectUri: "https://app/cb",
        codeChallenge: "CHAL",
        resource: "https://mcp.atlassian.com/v1/mcp",
        state: "st8",
        scopes: ["read:jira-work"],
      }),
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe(
      "https://mcp.atlassian.com/v1/mcp",
    );
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("state")).toBe("st8");
  });
});

describe("getOAuthAccessToken (B4 refresh)", () => {
  it("refreshes and returns the access token", async () => {
    const { store } = fakeStore(baseCfg);
    const fetchFn = vi
      .fn()
      .mockResolvedValue(okJson({ access_token: "AT1", expires_in: 3600 }));
    const token = await getOAuthAccessToken("t1", CONN, {
      store,
      fetchFn,
      connections: {} as never,
    });
    expect(token).toBe("AT1");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("persists a ROTATED refresh token before returning", async () => {
    const { store, put } = fakeStore(baseCfg);
    const fetchFn = vi.fn().mockResolvedValue(
      okJson({
        access_token: "AT2",
        refresh_token: "RT-rotated",
        expires_in: 3600,
      }),
    );
    await getOAuthAccessToken("t1", CONN, {
      store,
      fetchFn,
      connections: {} as never,
    });
    expect(put).toHaveBeenCalledOnce();
    const stored = JSON.parse(put.mock.calls[0][2]);
    expect(stored.refreshToken).toBe("RT-rotated");
    expect(put.mock.calls[0][1]).toBe(connectionSecretKey(CONN));
  });

  it("flips to needs_reauth and throws on invalid_grant (400)", async () => {
    const { store } = fakeStore(baseCfg);
    const setStatus = vi.fn(async () => {});
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({}),
    } as Response);
    await expect(
      getOAuthAccessToken("t1", CONN, {
        store,
        fetchFn,
        connections: { setStatus } as never,
      }),
    ).rejects.toBeInstanceOf(NeedsReauthError);
    expect(setStatus).toHaveBeenCalledWith("t1", CONN, "needs_reauth");
  });

  it("serves a fresh token from cache (no second refresh)", async () => {
    const { store } = fakeStore(baseCfg);
    const fetchFn = vi
      .fn()
      .mockResolvedValue(okJson({ access_token: "AT1", expires_in: 3600 }));
    await getOAuthAccessToken("t1", CONN, {
      store,
      fetchFn,
      connections: {} as never,
    });
    await getOAuthAccessToken("t1", CONN, {
      store,
      fetchFn,
      connections: {} as never,
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("stops serving a cached token once the connection is revoked (row gone)", async () => {
    const { store } = fakeStore(baseCfg);
    const fetchFn = vi
      .fn()
      .mockResolvedValue(okJson({ access_token: "AT1", expires_in: 3600 }));
    let clock = 1_000_000;
    const now = () => clock;
    // getById returns the live row first, then null after the revoke.
    const getById = vi
      .fn()
      .mockResolvedValueOnce({ status: "connected" })
      .mockResolvedValue(null);

    // 1) mint + cache the token
    const t1 = await getOAuthAccessToken("t1", CONN, {
      store,
      fetchFn,
      connections: { getById } as never,
      now,
    });
    expect(t1).toBe("AT1");

    // 2) within REVALIDATE_MS → served straight from cache, no status read
    clock += 30_000;
    await getOAuthAccessToken("t1", CONN, {
      store,
      fetchFn,
      connections: { getById } as never,
      now,
    });
    expect(getById).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledOnce();

    // 3) past REVALIDATE_MS, connection still live → revalidated, still cached
    clock += 61_000;
    await getOAuthAccessToken("t1", CONN, {
      store,
      fetchFn,
      connections: { getById } as never,
      now,
    });
    expect(getById).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledOnce(); // no re-refresh — token still fresh

    // 4) past REVALIDATE_MS again, now revoked → evict + refresh path throws NeedsReauth
    clock += 61_000;
    const revokedStore = {
      ...store,
      get: async () => null, // secret removed by revoke
    } as never;
    await expect(
      getOAuthAccessToken("t1", CONN, {
        store: revokedStore,
        fetchFn,
        connections: { getById } as never,
        now,
      }),
    ).rejects.toBeInstanceOf(NeedsReauthError);
    expect(getById).toHaveBeenCalledTimes(2);
  });

  it("evicts the cached token and defers to refresh when no longer `connected`", async () => {
    // needs_reauth normally means the refresh token is dead, so the refresh path throws.
    // Here refresh is mocked to succeed to prove the CACHED token is dropped (re-fetched),
    // not that a stale token keeps being served.
    const { store } = fakeStore(baseCfg);
    const fetchFn = vi
      .fn()
      .mockResolvedValue(okJson({ access_token: "AT1", expires_in: 3600 }));
    let clock = 2_000_000;
    const now = () => clock;
    const getById = vi
      .fn()
      .mockResolvedValueOnce({ status: "connected" })
      .mockResolvedValue({ status: "needs_reauth" });

    await getOAuthAccessToken("t1", CONN, {
      store,
      fetchFn,
      connections: { getById } as never,
      now,
    });
    // live revalidation keeps serving
    clock += 61_000;
    const stillOk = await getOAuthAccessToken("t1", CONN, {
      store,
      fetchFn,
      connections: { getById } as never,
      now,
    });
    expect(stillOk).toBe("AT1");
    // now needs_reauth → evict; refresh re-mints (secret still present here)
    clock += 61_000;
    await getOAuthAccessToken("t1", CONN, {
      store,
      fetchFn,
      connections: { getById } as never,
      now,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2); // evicted → forced a refresh
  });

  it("dedupes concurrent revalidations onto ONE status read (no thundering herd)", async () => {
    const { store } = fakeStore(baseCfg);
    const fetchFn = vi
      .fn()
      .mockResolvedValue(okJson({ access_token: "AT1", expires_in: 3600 }));
    let clock = 3_000_000;
    const now = () => clock;
    let resolveGet: (v: { status: string }) => void = () => {};
    const getById = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise((r) => (resolveGet = r as never)),
      );

    // mint + cache (no getById on the initial refresh path)
    await getOAuthAccessToken("t1", CONN, {
      store,
      fetchFn,
      connections: { getById } as never,
      now,
    });
    // three concurrent calls all past REVALIDATE_MS → must share one getById
    clock += 61_000;
    const calls = Promise.all([
      getOAuthAccessToken("t1", CONN, {
        store,
        fetchFn,
        connections: { getById } as never,
        now,
      }),
      getOAuthAccessToken("t1", CONN, {
        store,
        fetchFn,
        connections: { getById } as never,
        now,
      }),
      getOAuthAccessToken("t1", CONN, {
        store,
        fetchFn,
        connections: { getById } as never,
        now,
      }),
    ]);
    await Promise.resolve();
    resolveGet({ status: "connected" });
    const tokens = await calls;
    expect(tokens).toEqual(["AT1", "AT1", "AT1"]);
    expect(getById).toHaveBeenCalledOnce(); // one DB read served all three
  });

  it("serializes concurrent refreshes with the per-connection lock (one fetch)", async () => {
    const { store } = fakeStore(baseCfg);
    const fetchFn = vi
      .fn()
      .mockResolvedValue(okJson({ access_token: "AT1", expires_in: 3600 }));
    await Promise.all([
      getOAuthAccessToken("t1", CONN, {
        store,
        fetchFn,
        connections: {} as never,
      }),
      getOAuthAccessToken("t1", CONN, {
        store,
        fetchFn,
        connections: {} as never,
      }),
      getOAuthAccessToken("t1", CONN, {
        store,
        fetchFn,
        connections: {} as never,
      }),
    ]);
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
