import { createHash, randomBytes } from "node:crypto";
import { SecretStore } from "@naary/secrets";
import { ConnectionService, connectionSecretKey } from "./connection.service";
import { assertEgressAllowed } from "./egress";
import { NeedsReauthError } from "./errors";

const b64url = (b: Buffer) => b.toString("base64url");

/**
 * OAuth 2.1 (MCP authorization). The headless split: interactive consent runs
 * once in the web app (B3 — buildAuthorizeUrl + exchangeCode), capturing a
 * refresh token; the activity refreshes non-interactively at run time (B4).
 *
 * Per the MCP auth spec: PKCE, the RFC 8707 `resource` parameter (canonical MCP
 * server URL), and `offline_access` for refresh tokens.
 */
export interface OAuthConfig {
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  authorizationEndpoint?: string;
  issuer?: string;
  resource: string;
  scopes?: string[];
  /** Long-lived; set after consent. Used to mint short-lived access tokens. */
  refreshToken?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export type FetchFn = typeof fetch;

/** Build the PKCE authorize URL (pure). Requests offline_access + the resource param. */
export function buildAuthorizeUrl(p: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  state: string;
  scopes?: string[];
}): string {
  const url = new URL(p.authorizationEndpoint);
  const scope = [...new Set([...(p.scopes ?? []), "offline_access"])].join(" ");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
    scope,
    resource: p.resource,
    state: p.state,
  }).toString();
  return url.toString();
}

function form(fields: Record<string, string | undefined>): string {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields))
    if (v !== undefined) body.set(k, v);
  return body.toString();
}

/** Exchange an authorization code for tokens (B3 callback). */
export async function exchangeCode(
  p: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    resource: string;
  },
  fetchFn: FetchFn = fetch,
): Promise<TokenResponse> {
  const res = await fetchFn(p.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "authorization_code",
      code: p.code,
      code_verifier: p.codeVerifier,
      redirect_uri: p.redirectUri,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      resource: p.resource,
    }),
  });
  if (!res.ok) {
    throw new Error(`OAuth code exchange failed: ${res.status}`);
  }
  return (await res.json()) as TokenResponse;
}

/** Refresh-token grant. invalid_grant (400/401) → NeedsReauthError. */
async function refreshGrant(
  cfg: OAuthConfig,
  connectionId: string,
  fetchFn: FetchFn,
): Promise<TokenResponse> {
  const res = await fetchFn(cfg.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "refresh_token",
      refresh_token: cfg.refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      resource: cfg.resource,
    }),
  });
  if (res.status === 400 || res.status === 401) {
    throw new NeedsReauthError(connectionId);
  }
  if (!res.ok) {
    throw new Error(`OAuth refresh failed: ${res.status}`);
  }
  return (await res.json()) as TokenResponse;
}

// In-process access-token cache + per-connection refresh lock. NOTE: process-local
// only — multiple worker processes can still race a refresh (documented limitation;
// a distributed lock / Temporal serialization point is the real fix).
const accessCache = new Map<string, { token: string; expiresAt: number }>();
const inflight = new Map<string, Promise<string>>();

export interface OAuthDeps {
  store?: SecretStore;
  connections?: ConnectionService;
  fetchFn?: FetchFn;
  now?: () => number;
}

/** Reset the in-process caches — for tests only. */
export function __resetOAuthCaches(): void {
  accessCache.clear();
  inflight.clear();
}

/**
 * Get a valid access token for an OAuth connection: serve from cache if fresh,
 * else refresh (serialized per connection). On refresh-token rotation, persist
 * the NEW refresh token BEFORE returning the access token. invalid_grant flips
 * the connection to needs_reauth and throws NeedsReauthError.
 */
export async function getOAuthAccessToken(
  tenantId: string,
  connectionId: string,
  deps: OAuthDeps = {},
): Promise<string> {
  const now = deps.now ?? (() => Date.now());
  const cached = accessCache.get(connectionId);
  if (cached && cached.expiresAt > now() + 30_000) {
    return cached.token; // 30s clock-skew margin
  }
  const existing = inflight.get(connectionId);
  if (existing) return existing;

  const p = (async () => {
    const store = deps.store ?? new SecretStore();
    const connections = deps.connections ?? new ConnectionService();
    const fetchFn = deps.fetchFn ?? fetch;

    const raw = await store.get(tenantId, connectionSecretKey(connectionId));
    if (!raw) throw new NeedsReauthError(connectionId);
    const cfg = JSON.parse(raw) as OAuthConfig;

    let tokens: TokenResponse;
    try {
      tokens = await refreshGrant(cfg, connectionId, fetchFn);
    } catch (e) {
      if (e instanceof NeedsReauthError) {
        await connections.setStatus(tenantId, connectionId, "needs_reauth");
      }
      throw e;
    }

    // Rotation: persist the new refresh token before using the access token.
    if (tokens.refresh_token && tokens.refresh_token !== cfg.refreshToken) {
      await store.put(
        tenantId,
        connectionSecretKey(connectionId),
        JSON.stringify({ ...cfg, refreshToken: tokens.refresh_token }),
      );
    }

    accessCache.set(connectionId, {
      token: tokens.access_token,
      expiresAt: now() + (tokens.expires_in ?? 3600) * 1000,
    });
    return tokens.access_token;
  })().finally(() => inflight.delete(connectionId));

  inflight.set(connectionId, p);
  return p;
}

// --- B3 interactive consent (runs in the web app; deferred-live this slice) ---

/** PKCE pair (S256). */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export interface DiscoveredMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  issuer: string;
  scopesSupported?: string[];
}

/** Discover AS metadata: protected-resource-metadata (RFC 9728) → AS metadata (RFC 8414). */
export async function discoverOAuthMetadata(
  serverUrl: string,
  fetchFn: FetchFn = fetch,
): Promise<DiscoveredMetadata> {
  // SSRF guard: both the resource origin and the authorization-server origin it
  // returns are fetched server-side, so both must pass the egress allowlist.
  const origin = (await assertEgressAllowed(new URL(serverUrl).origin)).origin;
  const prm = (await (
    await fetchFn(`${origin}/.well-known/oauth-protected-resource`)
  ).json()) as { authorization_servers?: string[] };
  const asOrigin = (
    await assertEgressAllowed(
      new URL(prm.authorization_servers?.[0] ?? origin).origin,
    )
  ).origin;
  const asm = (await (
    await fetchFn(`${asOrigin}/.well-known/oauth-authorization-server`)
  ).json()) as Record<string, unknown>;
  return {
    authorizationEndpoint: String(asm.authorization_endpoint),
    tokenEndpoint: String(asm.token_endpoint),
    registrationEndpoint: asm.registration_endpoint
      ? String(asm.registration_endpoint)
      : undefined,
    issuer: String(asm.issuer),
    scopesSupported: asm.scopes_supported as string[] | undefined,
  };
}

/** Dynamic Client Registration (RFC 7591) — public client (PKCE, no secret). */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  fetchFn: FetchFn = fetch,
): Promise<{ clientId: string; clientSecret?: string }> {
  const res = await fetchFn(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "naary-orchestrator",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) throw new Error(`DCR failed: ${res.status}`);
  const j = (await res.json()) as { client_id: string; client_secret?: string };
  return { clientId: j.client_id, clientSecret: j.client_secret };
}

/** State carries the (non-secret) tenantId so the redirect callback can find it. */
const encodeState = (tenantId: string) =>
  `${tenantId}.${b64url(randomBytes(16))}`;
const tenantFromState = (state: string) => state.split(".")[0] ?? "";
const stateKey = (state: string) => `oauth-state:${state}`;

/** Begin consent: discover → DCR → PKCE → persist state → return the authorize URL. */
export async function startConsent(opts: {
  tenantId: string;
  connectionId: string;
  serverUrl: string;
  redirectUri: string;
  store?: SecretStore;
  fetchFn?: FetchFn;
}): Promise<{ authorizeUrl: string }> {
  const store = opts.store ?? new SecretStore();
  const meta = await discoverOAuthMetadata(opts.serverUrl, opts.fetchFn);
  const reg = meta.registrationEndpoint
    ? await registerClient(
        meta.registrationEndpoint,
        opts.redirectUri,
        opts.fetchFn,
      )
    : { clientId: "naary-orchestrator", clientSecret: undefined };
  const { verifier, challenge } = generatePkce();
  const state = encodeState(opts.tenantId);
  await store.put(
    opts.tenantId,
    stateKey(state),
    JSON.stringify({
      connectionId: opts.connectionId,
      codeVerifier: verifier,
      clientId: reg.clientId,
      clientSecret: reg.clientSecret,
      tokenEndpoint: meta.tokenEndpoint,
      issuer: meta.issuer,
      resource: opts.serverUrl,
      redirectUri: opts.redirectUri,
      scopes: meta.scopesSupported,
    }),
  );
  return {
    authorizeUrl: buildAuthorizeUrl({
      authorizationEndpoint: meta.authorizationEndpoint,
      clientId: reg.clientId,
      redirectUri: opts.redirectUri,
      codeChallenge: challenge,
      resource: opts.serverUrl,
      state,
      scopes: meta.scopesSupported,
    }),
  };
}

/** Complete consent: validate iss → exchange code → store encrypted refresh token. */
export async function completeConsent(opts: {
  state: string;
  code: string;
  iss?: string;
  store?: SecretStore;
  connections?: ConnectionService;
  fetchFn?: FetchFn;
}): Promise<{ connectionId: string }> {
  const store = opts.store ?? new SecretStore();
  const connections = opts.connections ?? new ConnectionService();
  const tenantId = tenantFromState(opts.state);

  const raw = await store.get(tenantId, stateKey(opts.state));
  if (!raw) throw new Error("Unknown or expired OAuth state");
  const s = JSON.parse(raw) as {
    connectionId: string;
    codeVerifier: string;
    clientId: string;
    clientSecret?: string;
    tokenEndpoint: string;
    issuer: string;
    resource: string;
    redirectUri: string;
    scopes?: string[];
  };
  if (opts.iss && s.issuer && opts.iss !== s.issuer) {
    throw new Error("Issuer mismatch (RFC 9207)");
  }

  const tokens = await exchangeCode(
    {
      tokenEndpoint: s.tokenEndpoint,
      clientId: s.clientId,
      clientSecret: s.clientSecret,
      code: opts.code,
      codeVerifier: s.codeVerifier,
      redirectUri: s.redirectUri,
      resource: s.resource,
    },
    opts.fetchFn,
  );
  if (!tokens.refresh_token) {
    throw new Error("No refresh token returned (offline_access not granted)");
  }

  const cfg: OAuthConfig = {
    clientId: s.clientId,
    clientSecret: s.clientSecret,
    tokenEndpoint: s.tokenEndpoint,
    issuer: s.issuer,
    resource: s.resource,
    scopes: s.scopes,
    refreshToken: tokens.refresh_token,
  };
  await store.put(
    tenantId,
    connectionSecretKey(s.connectionId),
    JSON.stringify(cfg),
  );
  await store.remove(tenantId, stateKey(opts.state));
  await connections.setStatus(tenantId, s.connectionId, "connected");
  return { connectionId: s.connectionId };
}
