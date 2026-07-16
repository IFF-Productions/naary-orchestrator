import { generateKeyPairSync } from "node:crypto";
import { decodeProtectedHeader, decodeJwt } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthConfigError, NeedsReauthError } from "../src/errors";
import {
  __ghAppDeps,
  __resetGithubAppCache,
  completeGithubAppInstall,
  getInstallationToken,
  resolveGithubAppHeader,
  startGithubAppInstall,
} from "../src/github-app";
import { connectionSecretKey } from "../src/connection.service";

// GitHub hands out a PKCS#1 key ("BEGIN RSA PRIVATE KEY"). Generate exactly that shape so the
// test exercises what prod gets — jose.importPKCS8 would REJECT this; createPrivateKey accepts it.
const { privateKey: pkcs1 } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

const fetchMock = vi.fn();
const setStatus = vi.fn();
const connections = {
  setStatus,
} as unknown as import("../src/connection.service").ConnectionService;

const FIXED_NOW = 1_770_000_000_000; // fixed clock (Date.now is otherwise banned-ish in tests)

beforeEach(() => {
  __resetGithubAppCache();
  fetchMock.mockReset();
  setStatus.mockReset().mockResolvedValue(undefined);
  __ghAppDeps.fetch = fetchMock as never;
  __ghAppDeps.assertEgressAllowed = (async (u: string) => new URL(u)) as never;
  __ghAppDeps.config = () => ({ appId: "123456", privateKey: pkcs1 });
  __ghAppDeps.now = () => FIXED_NOW;
});

function okTokenRes(token: string, expiresInMs = 3_600_000): Response {
  return {
    status: 200,
    ok: true,
    json: async () => ({
      token,
      expires_at: new Date(FIXED_NOW + expiresInMs).toISOString(),
    }),
  } as unknown as Response;
}

describe("getInstallationToken", () => {
  it("signs an RS256 app JWT from a PKCS#1 key and exchanges it for an installation token", async () => {
    fetchMock.mockResolvedValue(okTokenRes("ghs_installtoken"));

    const token = await getInstallationToken("42");

    expect(token).toBe("ghs_installtoken");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://api.github.com/app/installations/42/access_tokens",
    );
    expect(init.method).toBe("POST");
    // The Authorization is a Bearer app JWT: RS256, issued by the app id, ≤10 min, backdated.
    const jwt = String(init.headers.Authorization).replace("Bearer ", "");
    expect(decodeProtectedHeader(jwt).alg).toBe("RS256");
    const claims = decodeJwt(jwt);
    expect(claims.iss).toBe("123456");
    expect(claims.iat).toBe(Math.floor(FIXED_NOW / 1000) - 60); // 60s skew backdate
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(
      600,
    );
  });

  it("caches the token (a second call within its TTL does NOT re-exchange)", async () => {
    fetchMock.mockResolvedValue(okTokenRes("ghs_cached"));
    await getInstallationToken("42");
    await getInstallationToken("42");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("401/404 (uninstalled / revoked) → NeedsReauthError; stays PURE (no setStatus)", async () => {
    fetchMock.mockResolvedValue({
      status: 404,
      ok: false,
    } as unknown as Response);
    await expect(getInstallationToken("42")).rejects.toBeInstanceOf(
      NeedsReauthError,
    );
    // The per-connection status flip is the caller's job (resolveGithubAppHeader), NOT here —
    // the cache/exchange is keyed by installation, which several connections may share.
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("throws (retryable) on a transient non-2xx", async () => {
    fetchMock.mockResolvedValue({
      status: 500,
      ok: false,
    } as unknown as Response);
    await expect(getInstallationToken("42")).rejects.toThrow(
      /exchange failed: 500/,
    );
  });

  it("caches with a fallback TTL when expires_at is unparseable (not NaN → no re-exchange)", async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ token: "ghs_badexp", expires_at: "not-a-date" }),
    } as unknown as Response);
    await getInstallationToken("42");
    await getInstallationToken("42"); // second call within the fallback TTL → served from cache
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws AuthConfigError when the GitHub App isn't configured", async () => {
    __ghAppDeps.config = () => null;
    await expect(getInstallationToken("42")).rejects.toBeInstanceOf(
      AuthConfigError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws AuthConfigError (non-retryable) when the private key is malformed", async () => {
    __ghAppDeps.config = () => ({ appId: "123456", privateKey: "not-a-pem" });
    await expect(getInstallationToken("42")).rejects.toBeInstanceOf(
      AuthConfigError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("resolveGithubAppHeader", () => {
  it("flips status to needs_reauth on a MISSING grant (not just throws)", async () => {
    await expect(
      resolveGithubAppHeader("t1", "conn-1", { connections, grantJson: null }),
    ).rejects.toBeInstanceOf(NeedsReauthError);
    expect(setStatus).toHaveBeenCalledWith("t1", "conn-1", "needs_reauth");
  });

  it("flips status to needs_reauth on a MALFORMED grant (deterministic, not a retry)", async () => {
    await expect(
      resolveGithubAppHeader("t1", "conn-1", {
        connections,
        grantJson: "{not json",
      }),
    ).rejects.toBeInstanceOf(NeedsReauthError);
    expect(setStatus).toHaveBeenCalledWith("t1", "conn-1", "needs_reauth");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mints a Bearer header from a valid grant", async () => {
    fetchMock.mockResolvedValue(okTokenRes("ghs_fromgrant"));
    const h = await resolveGithubAppHeader("t1", "conn-1", {
      connections,
      grantJson: JSON.stringify({ installationId: "42" }),
    });
    expect(h).toEqual({ Authorization: "Bearer ghs_fromgrant" });
  });

  it("flips THIS connection to needs_reauth when the installation is revoked (401/404)", async () => {
    fetchMock.mockResolvedValue({
      status: 404,
      ok: false,
    } as unknown as Response);
    await expect(
      resolveGithubAppHeader("t1", "conn-1", {
        connections,
        grantJson: JSON.stringify({ installationId: "42" }),
      }),
    ).rejects.toBeInstanceOf(NeedsReauthError);
    // Re-wrapped with THIS connection's id (not the installation id) + status flipped here.
    expect(setStatus).toHaveBeenCalledWith("t1", "conn-1", "needs_reauth");
  });
});

// ── Install (connect) flow ──────────────────────────────────────────────────────────────
// A minimal in-memory SecretStore + ConnectionService so the state round-trip is exercised
// without a DB. The tenant is scoped by prefixing keys with tenantId.
function fakeStore() {
  const m = new Map<string, string>();
  const k = (t: string, e: string, key: string) => `${t}::${e}::${key}`;
  return {
    m,
    async put(t: string, e: string, key: string, v: string) {
      m.set(k(t, e, key), v);
    },
    async get(t: string, e: string, key: string) {
      return m.get(k(t, e, key)) ?? null;
    },
    async remove(t: string, e: string, key: string) {
      m.delete(k(t, e, key));
    },
    async prunePrefixOlderThan() {
      /* no-op in tests */
    },
  } as never;
}

describe("startGithubAppInstall / completeGithubAppInstall", () => {
  beforeEach(() => {
    __ghAppDeps.config = () => ({
      appId: "123456",
      privateKey: pkcs1,
      slug: "naary",
    });
  });

  it("round-trips: start persists state → callback creates the connection + stores the grant", async () => {
    const store = fakeStore();
    const create = vi
      .fn()
      .mockResolvedValue({ id: "conn-new", tenantId: "t1" });
    const setStatusFn = vi.fn().mockResolvedValue(undefined);
    const conns = {
      create,
      setStatus: setStatusFn,
    } as unknown as import("../src/connection.service").ConnectionService;

    const { installUrl, state } = await startGithubAppInstall({
      tenantId: "t1",
      environmentId: "e1",
      label: "Prod GitHub",
      store,
      now: () => FIXED_NOW,
    });
    expect(installUrl).toContain(
      "https://github.com/apps/naary/installations/new?state=",
    );
    // state = "<tenantId>.<environmentId>.<random>"
    expect(state.startsWith("t1.e1.")).toBe(true);

    const { connectionId } = await completeGithubAppInstall({
      state,
      installationId: "99",
      setupAction: "install",
      store,
      connections: conns,
      now: () => FIXED_NOW,
    });

    expect(connectionId).toBe("conn-new");
    expect(create).toHaveBeenCalledWith(
      "t1",
      "e1",
      expect.objectContaining({
        type: "github",
        authMode: "github_app",
        label: "Prod GitHub",
      }),
    );
    // The grant stored under conn:<id> is the installation id — NOT a token.
    expect(store.m.get(`t1::e1::${connectionSecretKey("conn-new")}`)).toBe(
      JSON.stringify({ installationId: "99" }),
    );
    expect(setStatusFn).toHaveBeenCalledWith("t1", "conn-new", "connected");
  });

  it("start throws when the app slug isn't configured", async () => {
    __ghAppDeps.config = () => ({ appId: "123456", privateKey: pkcs1 });
    await expect(
      startGithubAppInstall({
        tenantId: "t1",
        environmentId: "e1",
        label: "x",
        store: fakeStore(),
      }),
    ).rejects.toThrow(/not configured/);
  });

  it("callback fails closed on a missing installation_id or state (CSRF)", async () => {
    await expect(
      completeGithubAppInstall({ state: "", installationId: "99" }),
    ).rejects.toThrow(/Missing/);
    await expect(
      completeGithubAppInstall({ state: "t1.e1.abc", installationId: "" }),
    ).rejects.toThrow(/Missing/);
  });

  it("callback rejects an unknown/replayed state and never creates a connection", async () => {
    const store = fakeStore();
    const create = vi.fn();
    const conns = {
      create,
    } as unknown as import("../src/connection.service").ConnectionService;
    await expect(
      completeGithubAppInstall({
        state: "t1.e1.neverissued",
        installationId: "99",
        store,
        connections: conns,
      }),
    ).rejects.toThrow(/Unknown or expired/);
    expect(create).not.toHaveBeenCalled();
  });

  it("callback rejects an expired state (past TTL)", async () => {
    const store = fakeStore();
    const create = vi.fn();
    const conns = {
      create,
      setStatus: vi.fn(),
    } as unknown as import("../src/connection.service").ConnectionService;
    const { state } = await startGithubAppInstall({
      tenantId: "t1",
      environmentId: "e1",
      label: "x",
      store,
      now: () => FIXED_NOW,
    });
    await expect(
      completeGithubAppInstall({
        state,
        installationId: "99",
        store,
        connections: conns,
        now: () => FIXED_NOW + 11 * 60 * 1000, // 11 min later — past the 10-min TTL
      }),
    ).rejects.toThrow(/expired/);
    expect(create).not.toHaveBeenCalled();
  });

  it("rolls back the connection if storing the grant fails (no orphan)", async () => {
    const store = fakeStore();
    // Make the grant write throw AFTER the connection is created.
    store.put = (async (_t: string, _e: string, key: string) => {
      if (key.startsWith("conn:")) throw new Error("store down");
    }) as never;
    const remove = vi.fn().mockResolvedValue(undefined);
    const conns = {
      create: vi.fn().mockResolvedValue({ id: "conn-orphan", tenantId: "t1" }),
      setStatus: vi.fn(),
      remove,
    } as unknown as import("../src/connection.service").ConnectionService;
    // Seed a valid state directly (start would use the throwing put), then complete.
    const state = "t1.e1.seed";
    store.m.set(
      `t1::e1::gh-install-state:${state}`,
      JSON.stringify({
        tenantId: "t1",
        label: "x",
        expiresAt: FIXED_NOW + 1000,
      }),
    );
    await expect(
      completeGithubAppInstall({
        state,
        installationId: "99",
        store,
        connections: conns,
        now: () => FIXED_NOW,
      }),
    ).rejects.toThrow(/store down/);
    expect(remove).toHaveBeenCalledWith("t1", "conn-orphan");
  });
});
