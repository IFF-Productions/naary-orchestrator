import { beforeEach, describe, expect, it, vi } from "vitest";
import { NeedsReauthError, OAuthDiscoveryError } from "../src/errors";
import {
  __resetOAuthCaches,
  buildAuthorizeUrl,
  discoverOAuthMetadata,
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
        connections: { getById } as never,
        now,
      }),
      getOAuthAccessToken("t1", "e1", CONN, {
        store,
        fetchFn,
        assertEgress,
        connections: { getById } as never,
        now,
      }),
      getOAuthAccessToken("t1", "e1", CONN, {
        store,
        fetchFn,
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
        connections: {} as never,
      }),
      getOAuthAccessToken("t1", "e1", CONN, {
        store,
        fetchFn,
        assertEgress,
        connections: {} as never,
      }),
      getOAuthAccessToken("t1", "e1", CONN, {
        store,
        fetchFn,
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
    const fetchFn = vi.fn().mockResolvedValue(
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

/**
 * Discovery failures say what happened (Sentry NAARY-API-4).
 *
 * Production reported four events of `BlockedEgressError: Blocked outbound request: invalid URL`
 * from `POST /connections/:id/oauth/start`. That message is true and useless: the two `.well-known`
 * documents had 404'd, so `asm.token_endpoint` was `undefined`, `String(undefined)` produced the
 * literal `"undefined"`, and the egress guard — the LAST component to touch a value that went wrong
 * three steps earlier — refused to fetch it. The user saw an SSRF error for a server that simply
 * does not implement OAuth.
 */
describe("discoverOAuthMetadata — failing honestly (Sentry NAARY-API-4)", () => {
  const notFound = () =>
    ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }) as unknown as Response;

  it("a 404 on the AS document is 'this server doesn't advertise OAuth', not an egress error", async () => {
    const err = await discoverOAuthMetadata(
      "https://mcp.example.com",
      (async () => notFound()) as never,
      assertEgress as never,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthDiscoveryError);
    expect(err.message).toContain("doesn't advertise OAuth");
    // The exact regression: the words the user was shown before.
    expect(err.message).not.toMatch(/invalid URL|Blocked outbound/i);
  });

  it("a 200 document MISSING token_endpoint names the missing fields", async () => {
    // The precise production shape: the fetch succeeds, the body parses, and the fields we need
    // are simply absent — which used to become the string "undefined" and travel onward.
    const fetchFn = (async (url: string) =>
      url.includes("oauth-authorization-server")
        ? okJson({ issuer: "https://as.example.com" })
        : notFound()) as never;
    const err = await discoverOAuthMetadata(
      "https://mcp.example.com",
      fetchFn,
      assertEgress as never,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthDiscoveryError);
    expect(err.message).toContain("authorization_endpoint");
    expect(err.message).toContain("token_endpoint");
  });

  it("a serverUrl that isn't a URL blames the URL, not the egress guard", async () => {
    const err = await discoverOAuthMetadata(
      "acme.atlassian.net", // no scheme — what someone types into a "site" field
      (async () => okJson({})) as never,
      // The REAL guard here: this is the branch that produced the misleading message.
      undefined,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthDiscoveryError);
    expect(err.message).toContain("isn't a URL");
  });

  it("still succeeds when only the RFC 8414 document exists — the 9728 one is optional", async () => {
    // Not every server publishes protected-resource metadata, and a hard failure there would
    // break connections that work today.
    const fetchFn = (async (url: string) =>
      url.includes("oauth-authorization-server")
        ? okJson({
            issuer: "https://mcp.example.com",
            authorization_endpoint: "https://mcp.example.com/authorize",
            token_endpoint: "https://mcp.example.com/token",
          })
        : notFound()) as never;
    const meta = await discoverOAuthMetadata(
      "https://mcp.example.com",
      fetchFn,
      assertEgress as never,
    );
    expect(meta.tokenEndpoint).toBe("https://mcp.example.com/token");
  });
});

/**
 * The message has to match the STATUS, not merely beat the old one.
 *
 * Review caught this: the first version appended "this server doesn't advertise OAuth" to every
 * non-2xx. True of a 404; false of a 500 (the server may advertise it fine and be down) and of a
 * 401 (the document exists but is gated). Three different next actions for the reader, so three
 * sentences — plus `transient`, so the API can answer an upstream outage with a 502 instead of
 * blaming the caller for a request that was correct.
 */
describe("discoverOAuthMetadata — the status decides the sentence", () => {
  const status = (code: number) =>
    ({
      ok: false,
      status: code,
      json: async () => ({}),
    }) as unknown as Response;

  const discoverWith = (code: number) =>
    discoverOAuthMetadata(
      "https://mcp.example.com",
      (async () => status(code)) as never,
      assertEgress as never,
    ).catch((e) => e);

  it("404 is definitive: the server doesn't do OAuth, and retrying won't change that", async () => {
    const err = await discoverWith(404);
    expect(err.message).toContain("doesn't advertise OAuth");
    expect(err.transient).toBe(false);
  });

  it("500 is THEIR outage — not the caller's mistake, and possibly momentary", async () => {
    const err = await discoverWith(500);
    expect(err.message).toContain("may be temporary");
    // The bit the API turns into a 502 rather than a 400.
    expect(err.transient).toBe(true);
    expect(err.upstreamStatus).toBe(500);
    expect(err.message).not.toContain("doesn't advertise OAuth");
  });

  it("401 means the document is gated — a fixable misconfiguration, named as one", async () => {
    const err = await discoverWith(401);
    expect(err.message).toContain("publicly readable");
    expect(err.transient).toBe(false);
  });

  it("an unreachable server is transient too — a reset is not a verdict", async () => {
    const err = await discoverOAuthMetadata(
      "https://mcp.example.com",
      (async () => {
        throw new Error("ECONNRESET");
      }) as never,
      assertEgress as never,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthDiscoveryError);
    expect(err.transient).toBe(true);
  });
});
