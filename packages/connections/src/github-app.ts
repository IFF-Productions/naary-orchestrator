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
import { createPrivateKey, randomBytes } from "node:crypto";
import { SecretStore } from "@naary/secrets";
// `jose` is ESM-only; this file emits CommonJS (consumed via require), so a static import trips
// TS7's ESM/CJS guard. Load it lazily via dynamic import() — the sanctioned CJS→ESM path.
import {
  ConnectionService,
  ConnectionView,
  connectionSecretKey,
} from "./connection.service";
import { assertEgressAllowed } from "./egress";
import {
  AuthConfigError,
  ConnectCallbackError,
  NeedsReauthError,
} from "./errors";
import { safeFetch } from "./safe-fetch";

const GITHUB_API = "https://api.github.com";
/** Serve a cached installation token until this margin before its real expiry (GitHub ~1h). */
const SKEW_MS = 60_000;

/** Platform-level GitHub App credentials, from env. Null when the app isn't configured. */
export interface GithubAppConfig {
  appId: string;
  privateKey: string;
  /** The app's URL slug (e.g. "naary") — for the install URL. Undefined ⇒ install flow off. */
  slug?: string;
}

export function githubAppConfig(): GithubAppConfig | null {
  const appId = process.env.GITHUB_APP_ID;
  const raw = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !raw) return null;
  // A single-line env var carries the PEM's newlines as literal `\n` — un-escape them so
  // createPrivateKey gets a real PEM. (A key pasted with real newlines passes through.)
  const privateKey = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
  return { appId, privateKey, slug: process.env.GITHUB_APP_SLUG || undefined };
}

/** The grant stored under conn:<id> for a github_app connection (NOT a token — an install id). */
export interface GithubAppGrant {
  installationId: string;
}

/** Injectable seam (like the worker's __httpDeps) so tests mock the token exchange + config. */
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
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(cfg.privateKey);
  } catch {
    // A present-but-malformed key is a PLATFORM misconfig — retrying can't fix it, so map
    // to AuthConfigError (worker: non-retryable AUTH_NOT_CONFIGURED), not a generic retry loop.
    throw new AuthConfigError(
      "GITHUB_APP_PRIVATE_KEY is not a valid PEM private key (PKCS#1 or PKCS#8)",
    );
  }
  const iat = Math.floor(nowMs / 1000) - 60;
  const { SignJWT } = await import("jose");
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(cfg.appId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 600)
    .sign(key);
}

/** When GitHub's `expires_at` is missing/unparseable, cache for this long instead of NaN (which
 *  would disable caching → re-exchange on every call). Conservative vs the real ~1h lifetime. */
const FALLBACK_TTL_MS = 30 * 60_000;

/**
 * Mint (or serve cached) an installation access token for a GitHub App installation. Cached for
 * its lifetime (~1h minus skew), single-flight per installation. PURE w.r.t. connection state: a
 * 401/404 (installation uninstalled/revoked) throws NeedsReauthError but does NOT flip any
 * connection — the token cache is keyed by INSTALLATION (which several connections may share), so
 * the per-connection status flip is the caller's job (resolveGithubAppHeader). Other non-2xx /
 * network errors throw (retryable upstream); a missing/invalid app key throws AuthConfigError.
 */
export async function getInstallationToken(
  installationId: string,
): Promise<string> {
  const cfg = __ghAppDeps.config();
  if (!cfg) {
    // Platform misconfig, not a tenant problem → AuthConfigError (worker: non-retryable).
    throw new AuthConfigError(
      "GitHub App not configured (set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)",
    );
  }
  const now = __ghAppDeps.now();
  const cached = tokenCache.get(installationId);
  if (cached) {
    if (cached.expiresAtMs - SKEW_MS > now) return cached.token;
    tokenCache.delete(installationId); // expired — evict so the map stays bounded to live installs
  }

  const existing = inflight.get(installationId);
  if (existing) return existing;

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
      // Installation gone. Carry the installationId in the error; the caller re-wraps it with
      // its own connectionId + flips that connection's status (see resolveGithubAppHeader).
      throw new NeedsReauthError(installationId);
    }
    if (!res.ok) {
      throw new Error(
        `GitHub installation-token exchange failed: ${res.status}`,
      );
    }
    const body = (await res.json()) as { token: string; expires_at: string };
    const parsed = Date.parse(body.expires_at);
    tokenCache.set(installationId, {
      token: body.token,
      expiresAtMs: Number.isNaN(parsed) ? now + FALLBACK_TTL_MS : parsed,
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
  const connections = deps.connections ?? new ConnectionService();
  // A missing OR malformed grant is deterministic — nothing to retry. Flip the connection to
  // needs_reauth (so its state matches reality, like the 401/404 exchange path) and throw
  // NeedsReauthError (worker: non-retryable). Without this, a bad grant would throw a bare
  // SyntaxError → treated as a retryable transient, looping while status stays "connected".
  let installationId: string | undefined;
  if (deps.grantJson) {
    try {
      installationId = (JSON.parse(deps.grantJson) as GithubAppGrant)
        .installationId;
    } catch {
      /* fall through to reauth below */
    }
  }
  if (!installationId) {
    await connections.setStatus(tenantId, connectionId, "needs_reauth");
    throw new NeedsReauthError(connectionId); // no usable installation → must (re)install
  }
  try {
    const token = await getInstallationToken(installationId);
    return { Authorization: `Bearer ${token}` };
  } catch (e) {
    if (e instanceof NeedsReauthError) {
      // Installation revoked/uninstalled. getInstallationToken is keyed by installation and stays
      // pure, so flip THIS connection's status here and re-wrap the error with its connectionId —
      // that way two connections sharing one installation each get flipped by their own caller.
      await connections.setStatus(tenantId, connectionId, "needs_reauth");
      throw new NeedsReauthError(connectionId);
    }
    throw e;
  }
}

// ── Install (connect) flow ─────────────────────────────────────────────────────────────
// Parallel to oauth.ts startConsent/completeConsent, but INVERTED: GitHub hands us no
// installation id until AFTER the user installs, so — unlike OAuth (connection-first) — the
// CALLBACK creates the Connection (doc §3a). The state carries the tenantId (the callback is
// @Public with no auth context) + the pending label; it's single-use + TTL'd (CSRF, Sec#3).

/** Install-consent must complete within this window; a leaked state expires (mirrors OAuth). */
const INSTALL_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const installStateKey = (state: string) => `gh-install-state:${state}`;
// state = "<tenantId>.<environmentId>.<random>" so the @Public callback (no auth, no
// X-Environment-Id) can recover BOTH the tenant and the env the install began in — the new
// connection lands in that env. tenantId/environmentId are uuids (no "."), so the split is safe.
const encodeInstallState = (tenantId: string, environmentId: string) =>
  `${tenantId}.${environmentId}.${randomBytes(16).toString("base64url")}`;
const tenantFromInstallState = (state: string) => state.split(".")[0] ?? "";
const envFromInstallState = (state: string) => state.split(".")[1] ?? "";

interface InstallStateBlob {
  tenantId: string;
  label: string;
  expiresAt: number;
}

/**
 * Begin a GitHub App install: persist a single-use state carrying the tenant + pending label,
 * return the github.com install URL. The browser sends the user there; GitHub redirects to our
 * callback with `installation_id` + this `state`. Throws if the app (or its slug) isn't configured.
 */
export async function startGithubAppInstall(opts: {
  tenantId: string;
  environmentId: string;
  label: string;
  store?: SecretStore;
  now?: () => number;
}): Promise<{ installUrl: string; state: string }> {
  const cfg = __ghAppDeps.config();
  if (!cfg?.slug) {
    throw new AuthConfigError(
      "GitHub App install not configured (set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_SLUG)",
    );
  }
  const store = opts.store ?? new SecretStore();
  const now = opts.now ?? (() => Date.now());
  // Best-effort hygiene: sweep this env's abandoned install states (mirrors startConsent S-5).
  try {
    await store.prunePrefixOlderThan?.(
      opts.tenantId,
      opts.environmentId,
      "gh-install-state:",
      INSTALL_STATE_TTL_MS,
    );
  } catch {
    /* best-effort */
  }
  const state = encodeInstallState(opts.tenantId, opts.environmentId);
  const blob: InstallStateBlob = {
    tenantId: opts.tenantId,
    label: opts.label,
    expiresAt: now() + INSTALL_STATE_TTL_MS,
  };
  await store.put(
    opts.tenantId,
    opts.environmentId,
    installStateKey(state),
    JSON.stringify(blob),
  );
  const installUrl = `https://github.com/apps/${encodeURIComponent(
    cfg.slug,
  )}/installations/new?state=${encodeURIComponent(state)}`;
  return { installUrl, state };
}

/**
 * Complete a GitHub App install: validate + consume the state (CSRF, single-use, TTL), then
 * CREATE the github_app connection and store the `{ installationId }` grant under conn:<id>.
 * Ordered create-then-store; if storing the grant fails, the half-made connection is removed so
 * no orphan (which would later surface as a confusing MissingConnectionTokenError) lingers.
 *
 * setup_action is `install` (fresh) or `update` (repos changed on an existing install). Both just
 * (re)store the installation id here; richer update reconciliation can defer (doc §3a Slice 3).
 */
export async function completeGithubAppInstall(opts: {
  state: string;
  installationId: string;
  setupAction?: string;
  store?: SecretStore;
  connections?: ConnectionService;
  now?: () => number;
}): Promise<{ connectionId: string }> {
  if (!opts.state || !opts.installationId) {
    // Fail closed: GitHub must echo BOTH. A bare redirect (no state) is not a trusted install.
    // User-recoverable (a scanner hit, or an install begun outside our start flow) — the API
    // maps this to a 4xx, not a paging 500. Still fails closed: no connection is created.
    throw new ConnectCallbackError(
      "missing_params",
      "Missing installation_id or state",
    );
  }
  const store = opts.store ?? new SecretStore();
  const connections = opts.connections ?? new ConnectionService();
  const now = opts.now ?? (() => Date.now());
  // Recover tenant + env from the state (the @Public callback can't send X-Environment-Id) — the
  // new connection + its grant land in the env the install began in.
  const tenantId = tenantFromInstallState(opts.state);
  const environmentId = envFromInstallState(opts.state);

  const raw = await store.get(
    tenantId,
    environmentId,
    installStateKey(opts.state),
  );
  if (!raw)
    throw new ConnectCallbackError(
      "unknown_or_expired",
      "Unknown or expired GitHub install state",
    );
  // Consume immediately (single-use, before any create) so a leaked state can't be replayed.
  await store.remove(tenantId, environmentId, installStateKey(opts.state));
  const s = JSON.parse(raw) as InstallStateBlob;
  // Defence-in-depth: the tenant baked into the state blob must match the one derived from the
  // state prefix. A mismatch means a tampered state or corrupted storage — refuse it.
  if (s.tenantId !== tenantId) {
    throw new Error("GitHub install state tenant mismatch");
  }
  if (typeof s.expiresAt === "number" && s.expiresAt < now()) {
    throw new ConnectCallbackError("expired", "GitHub install state expired");
  }

  let conn: ConnectionView | undefined;
  try {
    conn = await connections.create(tenantId, environmentId, {
      type: "github",
      label: s.label,
      serverUrl: GITHUB_API,
      authMode: "github_app",
    });
    const grant: GithubAppGrant = { installationId: opts.installationId };
    await store.put(
      tenantId,
      environmentId,
      connectionSecretKey(conn.id),
      JSON.stringify(grant),
    );
    await connections.setStatus(tenantId, conn.id, "connected");
    return { connectionId: conn.id };
  } catch (err) {
    // Storing the grant failed after create → roll back so no tokenless orphan connection lingers.
    if (conn) {
      await connections.remove(tenantId, conn.id).catch(() => {});
    }
    throw err;
  }
}

// connectionSecretKey re-exported for the resolveAuthHeader branch that reads the grant.
export { connectionSecretKey };
