/**
 * GitHub App auth (docs/design/APP-AUTH.md, Slice 3). Instead of a pasted PAT, a github_app
 * connection stores an INSTALLATION id (the grant, under conn:<id>); at call time we mint a
 * short-lived INSTALLATION ACCESS TOKEN from the platform-level app credentials and use it as
 * the Bearer. This is the resolveAuthHeader path for `authMode: "github_app"`.
 *
 * SECURITY (CLAUDE.md rule 4): the app PRIVATE KEY is a PLATFORM secret (env, one per
 * deployment) — NEVER per-tenant, never returned, never logged. The app JWT + installation
 * token are used in-memory here only. Only tenantId/connectionId/installationId flow through.
 */
import { createPrivateKey } from "node:crypto";
import { SignJWT } from "jose";
import { ConnectionService, connectionSecretKey } from "./connection.service";
import { assertEgressAllowed } from "./egress";
import { NeedsReauthError } from "./errors";
import { safeFetch } from "./safe-fetch";

const GITHUB_API = "https://api.github.com";
/** Serve a cached installation token until this margin before its real expiry (GitHub ~1h). */
const SKEW_MS = 60_000;

/** Platform-level GitHub App credentials, from env. Null when the app isn't configured. */
export interface GithubAppConfig {
  appId: string;
  privateKey: string;
}

export function githubAppConfig(): GithubAppConfig | null {
  const appId = process.env.GITHUB_APP_ID;
  const raw = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !raw) return null;
  // A single-line env var carries the PEM's newlines as literal `\n` — un-escape them so
  // createPrivateKey gets a real PEM. (A key pasted with real newlines passes through.)
  const privateKey = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
  return { appId, privateKey };
}

/** The grant stored under conn:<id> for a github_app connection (NOT a token — an install id). */
export interface GithubAppGrant {
  installationId: string;
}

/** Injectable seam (mirrors __httpDeps / __oauthDeps) so tests mock the token exchange + config. */
export const __ghAppDeps = {
  fetch: safeFetch as unknown as typeof fetch,
  assertEgressAllowed,
  config: githubAppConfig,
  now: () => Date.now(),
};

// installationId → the cached installation token + its real expiry. Process-local (mirrors the
// OAuth access cache) + a per-installation single-flight lock so concurrent activities for one
// run don't stampede GitHub's token endpoint.
const tokenCache = new Map<string, { token: string; expiresAtMs: number }>();
const inflight = new Map<string, Promise<string>>();

/** Reset caches (tests). */
export function __resetGithubAppCache(): void {
  tokenCache.clear();
  inflight.clear();
}

/**
 * Sign a short-lived (~10 min) app JWT (RS256), backdated 60s for clock skew. createPrivateKey
 * accepts BOTH PKCS#1 (`BEGIN RSA PRIVATE KEY` — what GitHub's downloaded .pem is) AND PKCS#8,
 * unlike jose.importPKCS8 which only takes PKCS#8. A mangled key throws here with a clear error.
 */
async function signAppJwt(
  cfg: GithubAppConfig,
  nowMs: number,
): Promise<string> {
  const key = createPrivateKey(cfg.privateKey);
  const iat = Math.floor(nowMs / 1000) - 60;
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(cfg.appId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 600)
    .sign(key);
}

/**
 * Mint (or serve cached) an installation access token for a GitHub App installation. Cached for
 * its lifetime (~1h minus skew), single-flight per installation. A 401/404 means the app was
 * uninstalled or the installation revoked → flip the connection to needs_reauth + throw
 * NeedsReauthError (callIntegration maps it to non-retryable); other non-2xx / network errors
 * throw (retryable upstream).
 */
export async function getInstallationToken(
  tenantId: string,
  connectionId: string,
  installationId: string,
  deps: { connections?: ConnectionService } = {},
): Promise<string> {
  const cfg = __ghAppDeps.config();
  if (!cfg) {
    throw new Error(
      "GitHub App not configured (set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)",
    );
  }
  const now = __ghAppDeps.now();
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAtMs - SKEW_MS > now) return cached.token;

  const existing = inflight.get(installationId);
  if (existing) return existing;

  const connections = deps.connections ?? new ConnectionService();
  const p = (async () => {
    const appJwt = await signAppJwt(cfg, now);
    const url = `${GITHUB_API}/app/installations/${encodeURIComponent(
      installationId,
    )}/access_tokens`;
    await __ghAppDeps.assertEgressAllowed(url);
    const res = await __ghAppDeps.fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (res.status === 401 || res.status === 404) {
      await connections.setStatus(tenantId, connectionId, "needs_reauth");
      throw new NeedsReauthError(connectionId);
    }
    if (!res.ok) {
      throw new Error(
        `GitHub installation-token exchange failed: ${res.status}`,
      );
    }
    const body = (await res.json()) as { token: string; expires_at: string };
    tokenCache.set(installationId, {
      token: body.token,
      expiresAtMs: Date.parse(body.expires_at),
    });
    return body.token;
  })().finally(() => inflight.delete(installationId));
  inflight.set(installationId, p);
  return p;
}

/** Resolve the Authorization header for a github_app connection (used by resolveAuthHeader). */
export async function resolveGithubAppHeader(
  tenantId: string,
  connectionId: string,
  deps: { connections?: ConnectionService; grantJson: string | null },
): Promise<Record<string, string>> {
  if (!deps.grantJson) {
    throw new NeedsReauthError(connectionId); // no stored installation → must (re)install
  }
  const grant = JSON.parse(deps.grantJson) as GithubAppGrant;
  const token = await getInstallationToken(
    tenantId,
    connectionId,
    grant.installationId,
    { connections: deps.connections },
  );
  return { Authorization: `Bearer ${token}` };
}

// connectionSecretKey re-exported for the resolveAuthHeader branch that reads the grant.
export { connectionSecretKey };
