import { generateKeyPairSync } from "node:crypto";
import { decodeProtectedHeader, decodeJwt } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NeedsReauthError } from "../src/errors";
import {
  __ghAppDeps,
  __resetGithubAppCache,
  getInstallationToken,
} from "../src/github-app";

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

    const token = await getInstallationToken("t1", "conn-1", "42", {
      connections,
    });

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
    await getInstallationToken("t1", "conn-1", "42", { connections });
    await getInstallationToken("t1", "conn-1", "42", { connections });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("401/404 (uninstalled / revoked) → needs_reauth + NeedsReauthError, not a retry", async () => {
    fetchMock.mockResolvedValue({
      status: 404,
      ok: false,
    } as unknown as Response);
    await expect(
      getInstallationToken("t1", "conn-1", "42", { connections }),
    ).rejects.toBeInstanceOf(NeedsReauthError);
    expect(setStatus).toHaveBeenCalledWith("t1", "conn-1", "needs_reauth");
  });

  it("throws (retryable) on a transient non-2xx without flipping status", async () => {
    fetchMock.mockResolvedValue({
      status: 500,
      ok: false,
    } as unknown as Response);
    await expect(
      getInstallationToken("t1", "conn-1", "42", { connections }),
    ).rejects.toThrow(/exchange failed: 500/);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("throws when the GitHub App isn't configured", async () => {
    __ghAppDeps.config = () => null;
    await expect(
      getInstallationToken("t1", "conn-1", "42", { connections }),
    ).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
