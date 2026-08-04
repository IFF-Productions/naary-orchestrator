import { createHash, randomBytes } from "node:crypto";
import { getPrisma } from "@naary/db";
import { SecretStore } from "@naary/secrets";
import { ConnectionService, connectionSecretKey } from "./connection.service";
import { BlockedEgressError, assertEgressAllowed } from "./egress";
import { safeFetch } from "./safe-fetch";
import {
  ConnectCallbackError,
  NeedsReauthError,
  OAuthDiscoveryError,
} from "./errors";
import { hasDatabase } from "./config";

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
  /** RFC 8707 resource indicator (MCP path). OPTIONAL: fixed-client 3LO providers
   *  (e.g. Atlassian) leave it undefined so `refreshGrant` never sends a `resource`
   *  param their `/oauth/token` doesn't expect (`form()` drops undefined fields). */
  resource?: string;
  scopes?: string[];
  /** Long-lived; set after consent. Used to mint short-lived access tokens. */
  refreshToken?: string;
  /**
   * Last minted access token, persisted (encrypted, alongside the refresh token) so a
   * DIFFERENT process — which has a cold in-process cache — can find a still-fresh token
   * after blocking on the distributed refresh lock and SKIP a duplicate refresh. Written
   * on every successful refresh; read back inside the lock as the cross-process
   * double-check. A revoke removes the whole secret, so this can't outlive the grant.
   */
  accessToken?: string;
  /** Epoch-ms expiry of {@link accessToken} (now + expires_in at mint time). */
  accessExpiresAt?: number;
  /** Atlassian 3LO: the resolved cloud (site) id — needed for every Jira/Confluence
   *  API call (`https://api.atlassian.com/ex/{jira|confluence}/<cloudId>`). Rides this
   *  encrypted conn:<id> blob (design APP-AUTH.md §4), not a column; never logged. */
  cloudId?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export type FetchFn = typeof fetch;

/**
 * Default fetch for every OAuth wire call (#592): bound to the pinning safeFetch
 * dispatcher so token/registration POSTs — which carry client_secret / refresh_token —
 * can't be redirected or DNS-rebound onto a private address. Tests still inject a
 * plain stub via the fetchFn params/deps.
 */
const guardedFetch: FetchFn = ((url: unknown, init?: unknown) =>
  safeFetch(String(url), init as never)) as unknown as FetchFn;

/** Injectable egress assertion (tests use non-resolving fake hosts). */
export type AssertEgressFn = typeof assertEgressAllowed;

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
  fetchFn: FetchFn = guardedFetch,
  assertEgress: AssertEgressFn = assertEgressAllowed,
): Promise<TokenResponse> {
  // #592: the endpoint came from attacker-influenceable AS metadata — never POST the
  // code/client_secret to a non-public address.
  await assertEgress(p.tokenEndpoint);
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
  assertEgress: AssertEgressFn = assertEgressAllowed,
): Promise<TokenResponse> {
  // #592: re-validate at every refresh — this runs ~hourly in the worker forever, so a
  // host that later rebinds to an internal IP must fail here, not deliver the secret.
  await assertEgress(cfg.tokenEndpoint);
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

// In-process access-token cache + per-connection refresh coalescing. This is the
// FAST PATH only — cross-process correctness now comes from the Postgres advisory lock
// below (`refreshWithDistributedLock`), which serializes refreshes across every
// worker/API process keyed on the connection id. `inflight` still coalesces concurrent
// callers WITHIN one process (so we take the DB lock at most once per process per
// refresh), and holds even when the lock fails open.
//
// `checkedAt` bounds a cross-process revoke: a token minted here stays valid for its
// full lifetime (~1h), but a revoke/`needs_reauth` happens in the API process and can't
// reach this Map. So on a hit older than REVALIDATE_MS we re-read the connection's
// status (one cheap indexed SELECT — far cheaper than the OAuth refresh POST the cache
// exists to avoid) and stop serving if it's gone or no longer `connected`. Bounds a
// revoked connection's blast radius to REVALIDATE_MS instead of the token's TTL.
const accessCache = new Map<
  string,
  { token: string; expiresAt: number; checkedAt: number }
>();
const inflight = new Map<string, Promise<string>>();
// Per-connection revalidation lock: concurrent callers past REVALIDATE_MS share ONE
// status read (mirrors `inflight`), so the "at most one SELECT per 60s" bound holds
// under load instead of a thundering herd of getById calls.
const revalidating = new Map<string, Promise<boolean>>();

/** Re-check a cached connection's status at most this often (revoke-staleness bound). */
const REVALIDATE_MS = 60_000;

/**
 * Serialize `critical` across ALL processes for one connection id. The default runs it
 * under a Postgres transaction-scoped advisory lock; injectable so tests can stub the
 * DB/lock seam. It must invoke `critical` EXACTLY once (never retry it — that would risk
 * a double refresh).
 */
export type RefreshLock = <T>(
  connectionId: string,
  critical: () => Promise<T>,
) => Promise<T>;

/** How long to wait for the cross-process lock before failing open (see below). */
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 100;
/**
 * Interactive-transaction cap = the lock wait PLUS headroom for the refresh POST that
 * runs inside the same txn. Prisma's default is 5s, which our poll alone can exhaust —
 * an explicit, generous timeout keeps the txn from aborting a refresh mid-flight.
 */
const LOCK_TXN_TIMEOUT_MS = LOCK_WAIT_MS + 15_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Distributed per-connection refresh lock via `pg_advisory_xact_lock`. A second
 * process blocks here while the first refreshes, then runs `critical` and finds the
 * freshly-persisted access token (double-checked locking) instead of re-refreshing.
 *
 * FAIL-SAFE (Tier-1: a lock/DB hiccup must never deadlock a run):
 *  - We `pg_try_advisory_xact_lock` in a bounded poll (≤ LOCK_WAIT_MS) rather than the
 *    blocking `pg_advisory_xact_lock`, so the wait is bounded independent of any
 *    `lock_timeout` semantics, and the HTTP refresh runs INSIDE the same txn the lock is
 *    scoped to (the lock releases at COMMIT, right after the token is persisted).
 *  - If the lock can't be taken in time, or the DB is unreachable / not configured, we
 *    fall open and run `critical` WITHOUT the distributed lock — degrading to the
 *    in-process (`inflight`) serialization the fast path already provides. Availability
 *    over the optimization; at worst two processes do one extra sequential refresh.
 *  - `acquired` guards against re-running `critical` on its OWN error (e.g. NeedsReauth):
 *    only an acquisition/DB failure (acquired === false) falls open.
 *
 * Portability: `pg_advisory_xact_lock` + `hashtext` are Postgres-specific (fine — we're
 * Postgres-only). `hashtext` is int4, so distinct connection ids can hash-collide →
 * occasional false contention (over-serialized, never incorrect).
 */
const refreshWithDistributedLock: RefreshLock = async (
  connectionId,
  critical,
) => {
  if (!hasDatabase()) return critical(); // no DB (dev/test) → in-process only
  let acquired = false;
  try {
    return await getPrisma().$transaction(
      async (tx) => {
        const deadline = Date.now() + LOCK_WAIT_MS;
        for (;;) {
          const rows = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext(${connectionId})) AS locked`;
          if (rows[0]?.locked) break;
          if (Date.now() >= deadline) {
            throw new Error("oauth refresh lock timeout"); // → fall open below
          }
          await sleep(LOCK_POLL_MS);
        }
        acquired = true;
        return await critical();
      },
      { timeout: LOCK_TXN_TIMEOUT_MS },
    );
  } catch (e) {
    if (acquired) throw e; // critical's own failure — never retry it
    return critical(); // acquisition/DB failure → fail open (in-process serialization)
  }
};

export interface OAuthDeps {
  store?: SecretStore;
  connections?: ConnectionService;
  fetchFn?: FetchFn;
  /** Override the egress guard (tests only — defaults to assertEgressAllowed, #592). */
  assertEgress?: AssertEgressFn;
  now?: () => number;
  /** Override the cross-process refresh lock (tests inject a stub for the DB seam). */
  refreshLock?: RefreshLock;
}

/** Reset the in-process caches — for tests only. */
export function __resetOAuthCaches(): void {
  accessCache.clear();
  inflight.clear();
  revalidating.clear();
}

/**
 * Get a valid access token for an OAuth connection: serve from cache if fresh,
 * else refresh (serialized per connection). On refresh-token rotation, persist
 * the NEW refresh token BEFORE returning the access token. invalid_grant flips
 * the connection to needs_reauth and throws NeedsReauthError.
 */
export async function getOAuthAccessToken(
  tenantId: string,
  environmentId: string,
  connectionId: string,
  deps: OAuthDeps = {},
): Promise<string> {
  const now = deps.now ?? (() => Date.now());
  const cached = accessCache.get(connectionId);
  if (cached && cached.expiresAt > now() + 30_000) {
    // 30s clock-skew margin. Serve immediately if we revalidated recently; otherwise
    // confirm the connection wasn't revoked / flipped to needs_reauth in another process.
    if (now() - cached.checkedAt <= REVALIDATE_MS) {
      return cached.token;
    }
    // Dedupe concurrent revalidations onto one shared status read.
    let check = revalidating.get(connectionId);
    if (!check) {
      const connections = deps.connections ?? new ConnectionService();
      check = connections
        .getById(tenantId, connectionId)
        .then((row) => row?.status === "connected")
        .finally(() => revalidating.delete(connectionId));
      revalidating.set(connectionId, check);
    }
    const stillConnected = await check;
    // Re-read the entry: it may have been evicted/refreshed while we awaited.
    const fresh = accessCache.get(connectionId);
    if (stillConnected && fresh && fresh.expiresAt > now() + 30_000) {
      fresh.checkedAt = now();
      return fresh.token;
    }
    // Revoked (row gone) or no longer connected → stop serving the cached token and
    // fall through to refresh (which throws NeedsReauth once the secret is removed).
    accessCache.delete(connectionId);
  }
  const existing = inflight.get(connectionId);
  if (existing) return existing;

  const store = deps.store ?? new SecretStore();
  const connections = deps.connections ?? new ConnectionService();
  const fetchFn = deps.fetchFn ?? guardedFetch;
  const refreshLock = deps.refreshLock ?? refreshWithDistributedLock;

  const p = refreshLock(connectionId, async () => {
    // --- inside the distributed lock: double-checked locking ---
    // Another holder (this process or another) may have just refreshed while we blocked.
    // 1) same-process: a fresh entry in the in-process cache.
    const hot = accessCache.get(connectionId);
    if (hot && hot.expiresAt > now() + 30_000) return hot.token;

    const raw = await store.get(
      tenantId,
      environmentId,
      connectionSecretKey(connectionId),
    );
    if (!raw) throw new NeedsReauthError(connectionId);
    const cfg = JSON.parse(raw) as OAuthConfig;

    // 2) cross-process: a still-fresh access token persisted by another process's
    // refresh. Adopt it (warming this process's cache) and SKIP the refresh.
    if (
      cfg.accessToken &&
      cfg.accessExpiresAt &&
      cfg.accessExpiresAt > now() + 30_000
    ) {
      accessCache.set(connectionId, {
        token: cfg.accessToken,
        expiresAt: cfg.accessExpiresAt,
        checkedAt: now(), // adopted just now → revalidation clock still governs revokes
      });
      return cfg.accessToken;
    }

    let tokens: TokenResponse;
    try {
      tokens = await refreshGrant(
        cfg,
        connectionId,
        fetchFn,
        deps.assertEgress,
      );
    } catch (e) {
      if (e instanceof NeedsReauthError) {
        await connections.setStatus(tenantId, connectionId, "needs_reauth");
      }
      throw e;
    }

    // Persist the minted access token (+ rotated refresh token) on EVERY refresh so a
    // cold second process can adopt it via the cross-process double-check above. The new
    // refresh token is persisted here, BEFORE we return the access token (rotation
    // invariant). One encrypted write per ~hourly refresh — negligible.
    const expiresAt = now() + (tokens.expires_in ?? 3600) * 1000;
    await store.put(
      tenantId,
      environmentId,
      connectionSecretKey(connectionId),
      JSON.stringify({
        ...cfg,
        refreshToken: tokens.refresh_token ?? cfg.refreshToken,
        accessToken: tokens.access_token,
        accessExpiresAt: expiresAt,
      }),
    );

    accessCache.set(connectionId, {
      token: tokens.access_token,
      expiresAt,
      checkedAt: now(), // just minted → connection is live; start the revalidation clock
    });
    return tokens.access_token;
  }).finally(() => inflight.delete(connectionId));

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

/**
 * What a non-2xx on a discovery document actually tells the user.
 *
 * The first version said "this server doesn't advertise OAuth" for every status, which is true of a
 * 404 and false of the rest: a 500 means the server may advertise OAuth perfectly well and be
 * having a bad minute, and a 401/403 means the document exists but is gated — a configuration
 * mistake on their side, with a specific fix. Three different next actions, so three sentences.
 */
function describeDiscoveryStatus(status: number): string {
  if (status === 404 || status === 410) {
    return "this server doesn't advertise OAuth";
  }
  if (status === 401 || status === 403) {
    return "the metadata document is access-controlled; it has to be publicly readable";
  }
  if (status >= 500) {
    return "the server failed to serve its own metadata — this may be temporary";
  }
  return "that isn't a usable metadata response";
}

/**
 * Fetch one discovery document, insisting it actually IS one.
 *
 * `.json()` on a 404 was the hole: a server that answers HTML gets a parse error (fine), but one
 * that answers `{}` or a JSON error body parsed happily into an object with none of the fields we
 * need — and the missing values only became visible several steps later, as a URL that would not
 * parse. Status is checked first, then the body's shape, so the failure names the document.
 */
async function readDiscoveryDoc(
  fetchFn: FetchFn,
  url: string,
  origin: string,
  opts: { required: boolean },
): Promise<Record<string, unknown> | null> {
  let res: Awaited<ReturnType<FetchFn>>;
  try {
    res = await fetchFn(url);
  } catch (e) {
    if (!opts.required) return null;
    // Never reached it at all — DNS, TLS, a reset. Their side, and possibly momentary.
    throw new OAuthDiscoveryError(
      origin,
      `it could not be reached (${(e as Error).message})`,
      true,
    );
  }
  if (!res.ok) {
    if (!opts.required) return null;
    throw new OAuthDiscoveryError(
      origin,
      `${url} answered ${res.status} — ${describeDiscoveryStatus(res.status)}`,
      // A 5xx is the server's problem and may pass; everything else is a settled answer.
      res.status >= 500,
      res.status,
    );
  }
  try {
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== "object") {
      if (!opts.required) return null;
      throw new OAuthDiscoveryError(
        origin,
        `${url} didn't return a JSON object`,
      );
    }
    return body as Record<string, unknown>;
  } catch (e) {
    if (e instanceof OAuthDiscoveryError) throw e;
    if (!opts.required) return null;
    throw new OAuthDiscoveryError(origin, `${url} didn't return JSON`);
  }
}

/** Discover AS metadata: protected-resource-metadata (RFC 9728) → AS metadata (RFC 8414). */
export async function discoverOAuthMetadata(
  serverUrl: string,
  fetchFn: FetchFn = guardedFetch,
  assertEgress: AssertEgressFn = assertEgressAllowed,
): Promise<DiscoveredMetadata> {
  // SSRF guard: both the resource origin and the authorization-server origin it
  // returns are fetched server-side, so both must pass the egress allowlist.
  //
  // The serverUrl itself may not be a URL at all — a connection row can hold anything a user
  // typed. Answering that with the egress guard's "invalid URL" blames the wrong component
  // (see OAuthDiscoveryError).
  // Parsed FIRST, in its own step. `new URL()` throws a raw TypeError ("Invalid URL") before the
  // egress guard is ever reached, so catching only BlockedEgressError here let that TypeError
  // through — which is how this function reported a bad server URL before, one layer down. Caught
  // by the spec, not by reading it.
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new OAuthDiscoveryError(
      serverUrl || "(empty)",
      "that isn't a URL — a server URL must look like https://host",
    );
  }
  let origin: string;
  try {
    origin = (await assertEgress(parsed.origin)).origin;
  } catch (e) {
    // The guard's own "invalid URL" verdict, restated in this function's terms for the same
    // reason: the caller is trying to connect a server, not debug our egress layer.
    if (e instanceof BlockedEgressError && /invalid URL/i.test(e.message)) {
      throw new OAuthDiscoveryError(
        serverUrl,
        "that isn't a URL — a server URL must look like https://host",
      );
    }
    throw e;
  }
  const prm = (await readDiscoveryDoc(
    fetchFn,
    `${origin}/.well-known/oauth-protected-resource`,
    origin,
    // Optional by design: RFC 9728 is the newer half of the pair, and plenty of servers publish
    // only the RFC 8414 document. A miss here falls back to the resource's own origin, exactly
    // as before — what must NOT be tolerated is a miss on the AS document below.
    { required: false },
  )) as { authorization_servers?: string[] } | null;
  const asOrigin = (
    await assertEgress(
      new URL(prm?.authorization_servers?.[0] ?? origin).origin,
    )
  ).origin;
  const asm = (await readDiscoveryDoc(
    fetchFn,
    `${asOrigin}/.well-known/oauth-authorization-server`,
    asOrigin,
    { required: true },
  )) as Record<string, unknown>;
  // Every required endpoint is CHECKED rather than String()-ed.
  //
  // `String(undefined)` yields the literal "undefined", which then flowed into the egress guard
  // and came back as `BlockedEgressError: invalid URL` — an SSRF error for a server that simply
  // does not implement this flow (Sentry NAARY-API-4, four events in production). The guard was
  // doing its job; it was just the last component to touch a value that went wrong three steps
  // earlier.
  const missing = ["authorization_endpoint", "token_endpoint", "issuer"].filter(
    (k) => typeof asm[k] !== "string" || !(asm[k] as string).trim(),
  );
  if (missing.length > 0) {
    throw new OAuthDiscoveryError(
      asOrigin,
      `its metadata document is missing ${missing.join(", ")}`,
    );
  }
  const discovered: DiscoveredMetadata = {
    authorizationEndpoint: String(asm.authorization_endpoint),
    tokenEndpoint: String(asm.token_endpoint),
    registrationEndpoint: asm.registration_endpoint
      ? String(asm.registration_endpoint)
      : undefined,
    issuer: String(asm.issuer),
    scopesSupported: asm.scopes_supported as string[] | undefined,
  };
  // #592: the origins above are validated, but the metadata's endpoint URLs were used
  // VERBATIM — an AS document can point token/registration at cloud metadata or an
  // internal host. Validate each discovered URL before anything is sent to it.
  await assertEgress(discovered.tokenEndpoint);
  await assertEgress(discovered.authorizationEndpoint);
  if (discovered.registrationEndpoint) {
    await assertEgress(discovered.registrationEndpoint);
  }
  return discovered;
}

/** Dynamic Client Registration (RFC 7591) — public client (PKCE, no secret). */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  fetchFn: FetchFn = guardedFetch,
  assertEgress: AssertEgressFn = assertEgressAllowed,
): Promise<{ clientId: string; clientSecret?: string }> {
  await assertEgress(registrationEndpoint); // #592
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

/** State carries the (non-secret) tenantId + environmentId so the redirect callback — which can't
 *  send X-Environment-Id — can find the right env-scoped state row + store the token in that env.
 *  tenantId/environmentId are uuids (no dots), so a `.`-split is unambiguous. */
const encodeState = (tenantId: string, environmentId: string) =>
  `${tenantId}.${environmentId}.${b64url(randomBytes(16))}`;
const tenantFromState = (state: string) => state.split(".")[0] ?? "";
const envFromState = (state: string) => state.split(".")[1] ?? "";
const stateKey = (state: string) => `oauth-state:${state}`;

/** Consent must complete within this window; a leaked state expires (Sec#3). */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Begin consent: discover → DCR → PKCE → persist state → return the authorize URL. */
export async function startConsent(opts: {
  tenantId: string;
  environmentId: string;
  connectionId: string;
  serverUrl: string;
  redirectUri: string;
  store?: SecretStore;
  fetchFn?: FetchFn;
}): Promise<{ authorizeUrl: string }> {
  const store = opts.store ?? new SecretStore();
  // Audit S-5: opportunistically sweep this env's abandoned (never-completed)
  // consent states — their row is older than the consent TTL. Decryption-free,
  // best-effort (never block starting a new consent on a sweep hiccup).
  try {
    await store.prunePrefixOlderThan?.(
      opts.tenantId,
      opts.environmentId,
      "oauth-state:",
      OAUTH_STATE_TTL_MS,
    );
  } catch {
    /* best-effort storage hygiene */
  }
  const meta = await discoverOAuthMetadata(opts.serverUrl, opts.fetchFn);
  const reg = meta.registrationEndpoint
    ? await registerClient(
        meta.registrationEndpoint,
        opts.redirectUri,
        opts.fetchFn,
      )
    : { clientId: "naary-orchestrator", clientSecret: undefined };
  const { verifier, challenge } = generatePkce();
  const state = encodeState(opts.tenantId, opts.environmentId);
  await store.put(
    opts.tenantId,
    opts.environmentId,
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
      expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
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
  if (!opts.state || !opts.code) {
    // Fail closed: the provider must echo BOTH state (its CSRF credential) and code. A bare hit
    // or a consent-denied redirect (no code) is user-recoverable — a 4xx, not a paging 500.
    throw new ConnectCallbackError("missing_params", "Missing code or state");
  }
  const store = opts.store ?? new SecretStore();
  const connections = opts.connections ?? new ConnectionService();
  // The callback can't send X-Environment-Id — recover both from the state string (set at consent
  // start). The connection token is then stored in the SAME env the consent began in.
  const tenantId = tenantFromState(opts.state);
  const environmentId = envFromState(opts.state);

  const raw = await store.get(tenantId, environmentId, stateKey(opts.state));
  if (!raw)
    throw new ConnectCallbackError(
      "unknown_or_expired",
      "Unknown or expired OAuth state",
    );
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
    expiresAt?: number;
  };
  // Reject a leaked/abandoned state past its TTL, and consume it so it can't be
  // replayed (Sec#3). Remove before any token exchange.
  if (typeof s.expiresAt === "number" && s.expiresAt < Date.now()) {
    await store.remove(tenantId, environmentId, stateKey(opts.state));
    throw new ConnectCallbackError("expired", "OAuth state expired");
  }
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
    environmentId,
    connectionSecretKey(s.connectionId),
    JSON.stringify(cfg),
  );
  await store.remove(tenantId, environmentId, stateKey(opts.state));
  await connections.setStatus(tenantId, s.connectionId, "connected");
  return { connectionId: s.connectionId };
}
