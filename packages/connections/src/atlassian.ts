/**
 * Atlassian OAuth 2.0 3LO connect flow (docs/design/APP-AUTH.md §3b, §4). Replaces the
 * PAT-only Jira/Confluence path with app-based auth: the user authorizes our fixed
 * Atlassian OAuth app, we capture a refresh token, resolve the site's cloudId, and store
 * both under the connection's encrypted `conn:<id>` blob (an OAuthConfig, so the existing
 * `getOAuthAccessToken` refresh path serves it non-interactively at run time).
 *
 * FIXED-CLIENT (confidential) 3LO — NOT the MCP DCR/discovery path:
 *  - authorize:  https://auth.atlassian.com/authorize (+ audience=api.atlassian.com)
 *  - token:      https://auth.atlassian.com/oauth/token (client_secret sent — confidential)
 *  - cloudId:    https://api.atlassian.com/oauth/token/accessible-resources
 * No PKCE (confidential client); `offline_access` + `prompt=consent` are what yield the
 * refresh token.
 *
 * SECURITY (CLAUDE.md rules 3–4): the client secret + tokens are PLATFORM/tenant secrets —
 * client id/secret come from env (`ATLASSIAN_OAUTH_*`, one set per deployment), the refresh
 * token is encrypted at rest under `conn:<id>`, and NONE of them are ever returned to a
 * caller boundary, logged, or put in Temporal history/telemetry. The single-use `state` is
 * the callback's CSRF credential (10-min TTL), mirroring oauth.ts/github-app.ts.
 */
import { randomBytes } from "node:crypto";
import { SecretStore } from "@naary/secrets";
import { ConnectionService, connectionSecretKey } from "./connection.service";
import { assertEgressAllowed } from "./egress";
import { AuthConfigError } from "./errors";
import type { OAuthConfig } from "./oauth";
import { safeFetch } from "./safe-fetch";
import {
  atlassianClientId,
  atlassianClientSecret,
  atlassianScopes,
} from "./config";

// Fixed Atlassian 3LO endpoints (developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps).
const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const ACCESSIBLE_RESOURCES_URL =
  "https://api.atlassian.com/oauth/token/accessible-resources";
/** All 3LO grants target the api.atlassian.com gateway (required `audience`). */
const AUDIENCE = "api.atlassian.com";
/** The cloud-scoped Jira API base derived from the resolved cloudId (design §3b). */
const jiraApiBase = (cloudId: string) =>
  `https://api.atlassian.com/ex/jira/${cloudId}`;

/** Least-privilege default scopes; `offline_access` is REQUIRED to receive a refresh token. */
const DEFAULT_SCOPES = ["read:jira-work", "write:jira-work", "offline_access"];

/** Platform-level Atlassian OAuth app credentials, from env. Null when unconfigured. */
export interface AtlassianOAuthConfig {
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

export function atlassianOAuthConfig(): AtlassianOAuthConfig | null {
  const clientId = atlassianClientId();
  const clientSecret = atlassianClientSecret();
  if (!clientId || !clientSecret) return null;
  const configured = atlassianScopes();
  const scopes = configured.length > 0 ? configured : DEFAULT_SCOPES;
  return { clientId, clientSecret, scopes };
}

/** Injectable seam (mirrors github-app's __ghAppDeps) so tests mock HTTP + config. */
export const __atlassianDeps = {
  fetch: safeFetch as unknown as typeof fetch,
  assertEgressAllowed,
  config: atlassianOAuthConfig,
};

interface AtlassianTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

interface AccessibleResource {
  id: string;
  name?: string;
  url?: string;
}

/**
 * Build the Atlassian 3LO authorize URL (pure). Fixed endpoint + our client id, the
 * required `audience`, `offline_access` folded in (refresh token), and `prompt=consent`
 * so re-consent always re-issues one. No PKCE (confidential client).
 */
export function buildAtlassianAuthorizeUrl(p: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
}): string {
  const scope = [...new Set([...p.scopes, "offline_access"])].join(" ");
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    audience: AUDIENCE,
    client_id: p.clientId,
    scope,
    redirect_uri: p.redirectUri,
    state: p.state,
    response_type: "code",
    prompt: "consent",
  }).toString();
  return url.toString();
}

// state = "<tenantId>.<environmentId>.<random>" so the @Public callback (no auth, no
// X-Environment-Id) recovers BOTH the tenant and the env consent began in. uuids have no ".".
const encodeState = (tenantId: string, environmentId: string) =>
  `${tenantId}.${environmentId}.${randomBytes(16).toString("base64url")}`;
const tenantFromState = (state: string) => state.split(".")[0] ?? "";
const envFromState = (state: string) => state.split(".")[1] ?? "";
const stateKey = (state: string) => `atlassian-oauth-state:${state}`;

/** Consent must complete within this window; a leaked state expires (mirrors oauth.ts). */
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface StateBlob {
  connectionId: string;
  redirectUri: string;
  expiresAt: number;
}

/**
 * Begin Atlassian consent (connection-first, like oauth.ts startConsent): persist a
 * single-use CSRF state carrying the target connectionId + redirectUri, return the
 * authorize URL. Throws AuthConfigError if the platform app isn't configured.
 */
export async function startAtlassianConsent(opts: {
  tenantId: string;
  environmentId: string;
  connectionId: string;
  redirectUri: string;
  store?: SecretStore;
  now?: () => number;
}): Promise<{ authorizeUrl: string }> {
  const cfg = __atlassianDeps.config();
  if (!cfg) {
    throw new AuthConfigError(
      "Atlassian OAuth not configured (set ATLASSIAN_OAUTH_CLIENT_ID and ATLASSIAN_OAUTH_CLIENT_SECRET)",
    );
  }
  const store = opts.store ?? new SecretStore();
  const now = opts.now ?? (() => Date.now());
  // Best-effort hygiene: sweep this env's abandoned consent states (mirrors startConsent S-5).
  try {
    await store.prunePrefixOlderThan?.(
      opts.tenantId,
      opts.environmentId,
      "atlassian-oauth-state:",
      STATE_TTL_MS,
    );
  } catch {
    /* best-effort storage hygiene */
  }
  const state = encodeState(opts.tenantId, opts.environmentId);
  const blob: StateBlob = {
    connectionId: opts.connectionId,
    redirectUri: opts.redirectUri,
    expiresAt: now() + STATE_TTL_MS,
  };
  await store.put(
    opts.tenantId,
    opts.environmentId,
    stateKey(state),
    JSON.stringify(blob),
  );
  return {
    authorizeUrl: buildAtlassianAuthorizeUrl({
      clientId: cfg.clientId,
      redirectUri: opts.redirectUri,
      scopes: cfg.scopes,
      state,
    }),
  };
}

/** Exchange the authorization code for tokens (confidential client — client_secret sent). */
async function exchangeAtlassianCode(
  cfg: AtlassianOAuthConfig,
  code: string,
  redirectUri: string,
): Promise<AtlassianTokenResponse> {
  await __atlassianDeps.assertEgressAllowed(TOKEN_URL);
  const res = await __atlassianDeps.fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    // No response body echoed — it can carry the code/secret. Status only.
    throw new Error(`Atlassian code exchange failed: ${res.status}`);
  }
  return (await res.json()) as AtlassianTokenResponse;
}

/** Resolve the site's cloudId from the freshly-minted access token (design §3b). */
async function resolveCloudId(accessToken: string): Promise<string> {
  await __atlassianDeps.assertEgressAllowed(ACCESSIBLE_RESOURCES_URL);
  const res = await __atlassianDeps.fetch(ACCESSIBLE_RESOURCES_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Atlassian accessible-resources failed: ${res.status}`);
  }
  const resources = (await res.json()) as AccessibleResource[];
  const cloudId = resources?.[0]?.id;
  if (!cloudId) {
    // No accessible site → the grant is useless for any Jira/Confluence call. Fail closed
    // so the callback surfaces an error rather than storing a half-connected connection.
    throw new Error("Atlassian returned no accessible resources (no cloudId)");
  }
  return cloudId;
}

/**
 * Complete Atlassian consent: validate + consume the single-use state (CSRF, TTL), exchange
 * the code (confidential client), require a refresh token, resolve the cloudId, then store the
 * encrypted OAuthConfig grant under conn:<id> and point the connection at its cloud API base.
 * The stored blob is an OAuthConfig so the EXISTING getOAuthAccessToken/refreshGrant path
 * serves it at run time — `resource` is left undefined so Atlassian's /oauth/token never gets
 * an unexpected param. Returns the connectionId + resolved cloudId (cloudId is non-secret).
 */
export async function completeAtlassianConsent(opts: {
  state: string;
  code: string;
  store?: SecretStore;
  connections?: ConnectionService;
  now?: () => number;
}): Promise<{ connectionId: string; cloudId: string }> {
  if (!opts.state || !opts.code) {
    // Fail closed: Atlassian must echo BOTH. A bare redirect is not a trusted consent.
    throw new Error("Missing code or state");
  }
  const cfg = __atlassianDeps.config();
  if (!cfg) {
    throw new AuthConfigError("Atlassian OAuth not configured");
  }
  const store = opts.store ?? new SecretStore();
  const connections = opts.connections ?? new ConnectionService();
  const now = opts.now ?? (() => Date.now());
  // Recover tenant + env from the state (the @Public callback can't send X-Environment-Id).
  const tenantId = tenantFromState(opts.state);
  const environmentId = envFromState(opts.state);

  const raw = await store.get(tenantId, environmentId, stateKey(opts.state));
  if (!raw) throw new Error("Unknown or expired Atlassian OAuth state");
  // Consume immediately (single-use, before any token exchange) so a leaked state can't replay.
  await store.remove(tenantId, environmentId, stateKey(opts.state));
  const s = JSON.parse(raw) as StateBlob;
  if (typeof s.expiresAt === "number" && s.expiresAt < now()) {
    throw new Error("Atlassian OAuth state expired");
  }

  const tokens = await exchangeAtlassianCode(cfg, opts.code, s.redirectUri);
  if (!tokens.refresh_token) {
    throw new Error("No refresh token returned (offline_access not granted)");
  }
  const cloudId = await resolveCloudId(tokens.access_token);

  const grant: OAuthConfig = {
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    tokenEndpoint: TOKEN_URL,
    // resource intentionally undefined — Atlassian's /oauth/token doesn't expect one.
    scopes: cfg.scopes,
    refreshToken: tokens.refresh_token,
    cloudId,
  };
  await store.put(
    tenantId,
    environmentId,
    connectionSecretKey(s.connectionId),
    JSON.stringify(grant),
  );
  // Point the connection at its cloud-derived API base (design §3b) so the integration/HTTP
  // nodes call the right host. cloudId is the neutral source of truth in the grant blob;
  // Confluence would use ex/confluence/<cloudId> (call-time concern, out of this slice).
  await connections.setServerUrl(
    tenantId,
    s.connectionId,
    jiraApiBase(cloudId),
  );
  await connections.setStatus(tenantId, s.connectionId, "connected");
  return { connectionId: s.connectionId, cloudId };
}
