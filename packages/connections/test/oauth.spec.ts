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
