import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __atlassianDeps,
  atlassianOAuthConfig,
  buildAtlassianAuthorizeUrl,
  completeAtlassianConsent,
  startAtlassianConsent,
} from "../src/atlassian";
import { connectionSecretKey } from "../src/connection.service";
import { AuthConfigError } from "../src/errors";
import type { OAuthConfig } from "../src/oauth";
import type { SecretStore } from "@naary/secrets";

const CFG = {
  clientId: "atlassian-client-id",
  clientSecret: "atlassian-client-secret",
  scopes: ["read:jira-work", "write:jira-work", "offline_access"],
};

const FIXED_NOW = 1_770_000_000_000;

// Minimal in-memory SecretStore (mirrors github-app.spec) so the state round-trip runs DB-free.
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
    // `SecretStore` is a class, so a structural literal can never satisfy it — hence the cast.
    // It used to be `as never`, which also erased `m` and made every `store.m` read below a
    // type error that nothing checked (#1099). Intersecting the real `m` back in keeps the
    // assertions typed while the cast stays confined to the store surface.
  } as unknown as SecretStore & { m: Map<string, string> };
}

const fetchMock = vi.fn();
const jsonRes = (body: unknown, ok = true, status = 200): Response =>
  ({ ok, status, json: async () => body }) as unknown as Response;

beforeEach(() => {
  fetchMock.mockReset();
  __atlassianDeps.fetch = fetchMock as never;
  __atlassianDeps.assertEgressAllowed = (async (u: string) =>
    new URL(u)) as never;
  __atlassianDeps.config = () => CFG;
});

describe("default scopes", () => {
  /**
   * Set env for one call. `vi.stubEnv` rather than assigning to `process.env` and putting a copy
   * back: `process.env` is a live object with its own semantics, and REPLACING it (rather than
   * mutating keys) leaves later tests reading something that only looks like the real thing.
   * Same pattern as apps/web/test/firebase-lazy.spec.ts.
   */
  const withEnv = <T>(env: Record<string, string>, f: () => T) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    try {
      return f();
    } finally {
      vi.unstubAllEnvs();
    }
  };

  it("asks for read:jira-user — without it the CONNECTION CHECK is the one call that 401s", () => {
    // `get_myself` (GET /rest/api/2/myself) is the catalog's `probe: true` action: the thing a
    // user runs to find out whether their Atlassian connection works at all. Atlassian scopes it
    // `read:jira-user`, which `read:jira-work` does not imply — so the health check was guaranteed
    // to fail, as a bare 401 indistinguishable from a bad credential. Reported from production.
    const cfg = withEnv(
      {
        ATLASSIAN_OAUTH_CLIENT_ID: "cid",
        ATLASSIAN_OAUTH_CLIENT_SECRET: "sec",
        ATLASSIAN_OAUTH_SCOPES: "",
      },
      atlassianOAuthConfig,
    );
    expect(cfg?.scopes).toContain("read:jira-user");
    // Still the two it always had, and the refresh-token one — this widened the set, it did not
    // replace it.
    expect(cfg?.scopes).toEqual(
      expect.arrayContaining([
        "read:jira-work",
        "write:jira-work",
        "offline_access",
      ]),
    );
  });

  it("an explicit ATLASSIAN_OAUTH_SCOPES still wins outright", () => {
    // The env override is a full replacement, not an addition: an operator narrowing the set must
    // get exactly what they asked for.
    const cfg = withEnv(
      {
        ATLASSIAN_OAUTH_CLIENT_ID: "cid",
        ATLASSIAN_OAUTH_CLIENT_SECRET: "sec",
        ATLASSIAN_OAUTH_SCOPES: "read:jira-work",
      },
      atlassianOAuthConfig,
    );
    expect(cfg?.scopes).toEqual(["read:jira-work"]);
  });
});

describe("buildAtlassianAuthorizeUrl", () => {
  it("uses the fixed endpoint with the right audience, scope, state, and no PKCE", () => {
    const url = new URL(
      buildAtlassianAuthorizeUrl({
        clientId: "atlassian-client-id",
        redirectUri: "https://app/atlassian/oauth/callback",
        scopes: ["read:jira-work", "write:jira-work"],
        state: "t1.e1.rnd",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://auth.atlassian.com/authorize",
    );
    expect(url.searchParams.get("audience")).toBe("api.atlassian.com");
    expect(url.searchParams.get("client_id")).toBe("atlassian-client-id");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("t1.e1.rnd");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app/atlassian/oauth/callback",
    );
    // offline_access is folded in (required for a refresh token); PKCE is absent (confidential).
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("code_challenge")).toBeNull();
  });
});

describe("startAtlassianConsent", () => {
  it("persists a single-use state and returns the authorize URL", async () => {
    const store = fakeStore();
    const { authorizeUrl } = await startAtlassianConsent({
      tenantId: "t1",
      environmentId: "e1",
      connectionId: "conn-1",
      redirectUri: "https://app/atlassian/oauth/callback",
      store,
      now: () => FIXED_NOW,
    });
    const url = new URL(authorizeUrl);
    const state = url.searchParams.get("state") ?? "";
    expect(state.startsWith("t1.e1.")).toBe(true);
    // The state row carries the target connectionId + redirectUri, TTL'd 10 min ahead.
    const raw = store.m.get(`t1::e1::atlassian-oauth-state:${state}`);
    expect(raw).toBeDefined();
    const blob = JSON.parse(raw as string);
    expect(blob.connectionId).toBe("conn-1");
    expect(blob.redirectUri).toBe("https://app/atlassian/oauth/callback");
    expect(blob.expiresAt).toBe(FIXED_NOW + 10 * 60 * 1000);
  });

  it("throws AuthConfigError when the Atlassian app isn't configured", async () => {
    __atlassianDeps.config = () => null;
    await expect(
      startAtlassianConsent({
        tenantId: "t1",
        environmentId: "e1",
        connectionId: "conn-1",
        redirectUri: "https://app/cb",
        store: fakeStore(),
      }),
    ).rejects.toBeInstanceOf(AuthConfigError);
  });
});

describe("completeAtlassianConsent", () => {
  async function seedState(store: ReturnType<typeof fakeStore>) {
    const { authorizeUrl } = await startAtlassianConsent({
      tenantId: "t1",
      environmentId: "e1",
      connectionId: "conn-1",
      redirectUri: "https://app/atlassian/oauth/callback",
      store,
      now: () => FIXED_NOW,
    });
    return new URL(authorizeUrl).searchParams.get("state") as string;
  }

  it("exchanges the code, stores an encrypted refresh grant, and resolves+persists cloudId", async () => {
    const store = fakeStore();
    const state = await seedState(store);
    // 1st fetch = token exchange, 2nd = accessible-resources → cloudId.
    fetchMock
      .mockResolvedValueOnce(
        jsonRes({
          access_token: "AT-atlassian",
          refresh_token: "RT-atlassian",
          expires_in: 3600,
        }),
      )
      .mockResolvedValueOnce(
        jsonRes([
          { id: "cloud-123", name: "acme", url: "https://acme.atlassian.net" },
        ]),
      );
    const setServerUrl = vi.fn().mockResolvedValue(undefined);
    const setStatus = vi.fn().mockResolvedValue(undefined);
    const connections = {
      setServerUrl,
      setStatus,
    } as unknown as import("../src/connection.service").ConnectionService;

    const out = await completeAtlassianConsent({
      state,
      code: "auth-code",
      store,
      connections,
      now: () => FIXED_NOW,
    });

    expect(out).toEqual({ connectionId: "conn-1", cloudId: "cloud-123" });

    // Token exchange: POST to the fixed token endpoint with the confidential client_secret.
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe("https://auth.atlassian.com/oauth/token");
    expect(tokenInit.method).toBe("POST");
    const body = JSON.parse(tokenInit.body);
    expect(body.grant_type).toBe("authorization_code");
    expect(body.client_secret).toBe("atlassian-client-secret");
    expect(body.code).toBe("auth-code");

    // cloudId resolution: GET accessible-resources with the freshly-minted access token.
    const [resUrl, resInit] = fetchMock.mock.calls[1];
    expect(resUrl).toBe(
      "https://api.atlassian.com/oauth/token/accessible-resources",
    );
    expect(resInit.headers.Authorization).toBe("Bearer AT-atlassian");

    // The stored grant is an OAuthConfig blob under conn:<id>: refresh token + cloudId,
    // confidential client creds, the fixed token endpoint, and NO `resource` param.
    const stored = store.m.get(`t1::e1::${connectionSecretKey("conn-1")}`);
    const grant = JSON.parse(stored as string) as OAuthConfig;
    expect(grant.refreshToken).toBe("RT-atlassian");
    expect(grant.cloudId).toBe("cloud-123");
    expect(grant.clientSecret).toBe("atlassian-client-secret");
    expect(grant.tokenEndpoint).toBe("https://auth.atlassian.com/oauth/token");
    expect(grant.resource).toBeUndefined();

    // The connection is pointed at its cloud-derived API base and marked connected.
    expect(setServerUrl).toHaveBeenCalledWith(
      "t1",
      "conn-1",
      "https://api.atlassian.com/ex/jira/cloud-123",
    );
    expect(setStatus).toHaveBeenCalledWith("t1", "conn-1", "connected");

    // The single-use state was consumed (can't be replayed).
    expect(
      store.m.get(`t1::e1::atlassian-oauth-state:${state}`),
    ).toBeUndefined();
  });

  it("throws (and stores nothing) when no refresh token is returned", async () => {
    const store = fakeStore();
    const state = await seedState(store);
    fetchMock.mockResolvedValueOnce(
      jsonRes({ access_token: "AT-only", expires_in: 3600 }),
    );
    const connections = {
      setServerUrl: vi.fn(),
      setStatus: vi.fn(),
    } as unknown as import("../src/connection.service").ConnectionService;
    await expect(
      completeAtlassianConsent({
        state,
        code: "auth-code",
        store,
        connections,
        now: () => FIXED_NOW,
      }),
    ).rejects.toThrow(/No refresh token/);
    expect(
      store.m.get(`t1::e1::${connectionSecretKey("conn-1")}`),
    ).toBeUndefined();
    // accessible-resources is never called if there's no refresh token.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws when Atlassian returns no accessible resources (no cloudId)", async () => {
    const store = fakeStore();
    const state = await seedState(store);
    fetchMock
      .mockResolvedValueOnce(
        jsonRes({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(jsonRes([]));
    const connections = {
      setServerUrl: vi.fn(),
      setStatus: vi.fn(),
    } as unknown as import("../src/connection.service").ConnectionService;
    await expect(
      completeAtlassianConsent({
        state,
        code: "auth-code",
        store,
        connections,
        now: () => FIXED_NOW,
      }),
    ).rejects.toThrow(/no accessible resources/i);
  });

  it("fails closed on a missing code or state (CSRF)", async () => {
    await expect(
      completeAtlassianConsent({ state: "", code: "c" }),
    ).rejects.toThrow(/Missing/);
    await expect(
      completeAtlassianConsent({ state: "t1.e1.x", code: "" }),
    ).rejects.toThrow(/Missing/);
  });

  it("rejects an unknown/replayed state and never exchanges the code", async () => {
    const store = fakeStore();
    await expect(
      completeAtlassianConsent({
        state: "t1.e1.neverissued",
        code: "auth-code",
        store,
        connections: {} as never,
        now: () => FIXED_NOW,
      }),
    ).rejects.toThrow(/Unknown or expired/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an expired state (past TTL) and never exchanges the code", async () => {
    const store = fakeStore();
    const state = await seedState(store);
    await expect(
      completeAtlassianConsent({
        state,
        code: "auth-code",
        store,
        connections: {} as never,
        now: () => FIXED_NOW + 11 * 60 * 1000, // 11 min later — past the 10-min TTL
      }),
    ).rejects.toThrow(/expired/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
