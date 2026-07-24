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
/** #592 seam: the token endpoint is a fake host — skip the real DNS egress guard. */
const assertEgress = vi.fn(async (url: string) => new URL(url));

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
    const token = await getOAuthAccessToken("t1", "e1", CONN, {
      store,
      fetchFn,
      assertEgress,
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
    await getOAuthAccessToken("t1", "e1", CONN, {
      store,
      fetchFn,
      assertEgress,
      connections: {} as never,
    });
    expect(put).toHaveBeenCalledOnce();
    // put(tenantId, environmentId, key, value) — key is arg 2, JSON payload arg 3.
    const stored = JSON.parse(put.mock.calls[0][3]);
    expect(stored.refreshToken).toBe("RT-rotated");
    expect(put.mock.calls[0][1]).toBe("e1");
    expect(put.mock.calls[0][2]).toBe(connectionSecretKey(CONN));
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
      getOAuthAccessToken("t1", "e1", CONN, {
        store,
        fetchFn,
        assertEgress,
      assertEgress,
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
    await getOAuthAccessToken("t1", "e1", CONN, {
      store,
      fetchFn,
      assertEgress,
      connections: {} as never,
    });
    await getOAuthAccessToken("t1", "e1", CONN, {
      store,
      fetchFn,
      assertEgress,
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
    const t1 = await getOAuthAccessToken("t1", "e1", CONN, {
      store,
      fetchFn,
      assertEgress,
      connections: { getById } as never,
      now,
    });
    expect(t1).toBe("AT1");

    // 2) within REVALIDATE_MS → served straight from cache, no status read
    clock += 30_000;
    await getOAuthAccessToken("t1", "e1", CONN, {
      store,
      fetchFn,
      assertEgress,
      connections: { getById } as never,
      now,
    });
    expect(getById).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledOnce();

    // 3) past REVALIDATE_MS, connection still live → revalidated, still cached
    clock += 61_000;
    await getOAuthAccessToken("t1", "e1", CONN, {
      store,
      fetchFn,
      assertEgress,
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
      getOAuthAccessToken("t1", "e1", CONN, {
        store: revokedStore,
        fetchFn,
        assertEgress,
      assertEgress,
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

    await getOAuthAccessToken("t1", "e1", CONN, {
      store,
      fetchFn,
      assertEgress,
      connections: { getById } as never,
      now,
    });
    // live revalidation keeps serving
    clock += 61_000;
    const stillOk = await getOAuthAccessToken("t1", "e1", CONN, {
      store,
      fetchFn,
      assertEgress,
      connections: { getById } as never,
      now,
    });
    expect(stillOk).toBe("AT1");
    // now needs_reauth → evict; refresh re-mints (secret still present here)
    clock += 61_000;
    await getOAuthAccessToken("t1", "e1", CONN, {
      store,
      fetchFn,
      assertEgress,
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
    await getOAuthAccessToken("t1", "e1", CONN, {
      store,
      fetchFn,
      assertEgress,
      connections: { getById } as never,
      now,
    });
    // three concurrent calls all past REVALIDATE_MS → must share one getById
    clock += 61_000;
    const calls = Promise.all([
      getOAuthAccessToken("t1", "e1", CONN, {
        store,
        fetchFn,
        assertEgress,
      assertEgress,
        connections: { getById } as never,
        now,
      }),
      getOAuthAccessToken("t1", "e1", CONN, {
        store,
        fetchFn,
        assertEgress,
      assertEgress,
        connections: { getById } as never,
        now,
      }),
      getOAuthAccessToken("t1", "e1", CONN, {
        store,
        fetchFn,
        assertEgress,
      assertEgress,
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
      getOAuthAccessToken("t1", "e1", CONN, {
        store,
        fetchFn,
        assertEgress,
      assertEgress,
        connections: {} as never,
      }),
      getOAuthAccessToken("t1", "e1", CONN, {
        store,
        fetchFn,
        assertEgress,
      assertEgress,
        connections: {} as never,
      }),
      getOAuthAccessToken("t1", "e1", CONN, {
        store,
        fetchFn,
        assertEgress,
      assertEgress,
        connections: {} as never,
      }),
    ]);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  // A PERSISTING secret store: get returns the current config, put replaces it — the
  // encrypted, DB-backed store BOTH processes read/write. (The `fakeStore` above has a
  // no-op put, so it can't model cross-process sharing.)
  function persistingStore(initial: OAuthConfig) {
    let cur = JSON.stringify(initial);
    const put = vi.fn(async (_t: string, _e: string, _k: string, v: string) => {
      cur = v;
    });
    return {
      store: {
        get: async () => cur,
        put,
        remove: async () => {},
        prunePrefixOlderThan: async () => 0,
      } as never,
      put,
      read: () => JSON.parse(cur) as OAuthConfig,
    };
  }

  it("distributed lock: a cold second process adopts the persisted token — ONE refresh across both", async () => {
    // Two worker processes share one connection. inflight coalesces concurrent callers
    // WITHIN a process, so genuine cross-process contention can only be modelled by a
    // COLD in-process cache (a second process) hitting the SAME persisted store while a
    // serializing lock (the advisory-lock seam) orders them. We stub that lock and reset
    // the in-process caches between the two calls to stand in for the second process.
    const { store, put } = persistingStore(baseCfg);
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        okJson({
          access_token: "AT1",
          refresh_token: "RT-rotated",
          expires_in: 3600,
        }),
      );
    // Serialize critical sections exactly like pg_advisory_xact_lock does across procs.
    let chain: Promise<unknown> = Promise.resolve();
    const refreshLock = vi.fn(
      (_id: string, critical: () => Promise<unknown>) => {
        const run = chain.then(critical);
        chain = run.then(
          () => {},
          () => {},
        );
        return run;
      },
    ) as never;

    // Process A (cold cache) → actually refreshes and persists AT1 into the shared store.
    const a = await getOAuthAccessToken("t1", "e1", CONN, {
      store,
      fetchFn,
      assertEgress,
      connections: {} as never,
      refreshLock,
    });
    expect(a).toBe("AT1");
    // The minted access token is now persisted for other processes to adopt.
    expect(put).toHaveBeenCalledOnce();

    // Process B: a DIFFERENT worker → cold in-process cache, same persisted store.
    __resetOAuthCaches();
    const b = await getOAuthAccessToken("t1", "e1", CONN, {
      store,
      fetchFn,
      assertEgress,
      connections: {} as never,
      refreshLock,
    });

    // B blocked on the lock, then re-read the config INSIDE the lock, found AT1 still
    // fresh, and SKIPPED the refresh (double-checked locking).
    expect(b).toBe("AT1");
    expect(fetchFn).toHaveBeenCalledOnce(); // exactly one refresh across both processes
    expect(refreshLock).toHaveBeenCalledTimes(2); // but both took the distributed lock
    expect(put).toHaveBeenCalledOnce(); // B persisted nothing — it adopted A's token
  });

  it("distributed lock: does NOT adopt a persisted token that is already expiring", async () => {
    // A stale persisted access token (expiry within the 30s skew margin) must fall
    // through to a real refresh, not be served.
    const stale: OAuthConfig = {
      ...baseCfg,
      accessToken: "AT-stale",
      accessExpiresAt: 100, // long past
    };
    const { store } = persistingStore(stale);
    const fetchFn = vi
      .fn()
      .mockResolvedValue(okJson({ access_token: "AT-new", expires_in: 3600 }));
    const refreshLock = vi.fn((_id: string, c: () => Promise<unknown>) =>
      c(),
    ) as never;

    const token = await getOAuthAccessToken("t1", "e1", CONN, {
      store,
      fetchFn,
      assertEgress,
      connections: {} as never,
      refreshLock,
      now: () => 1_000_000,
    });
    expect(token).toBe("AT-new");
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
