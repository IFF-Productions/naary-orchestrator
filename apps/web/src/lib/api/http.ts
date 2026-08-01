/**
 * Shared HTTP core for the API client: base URL, bearer/workspace/environment
 * headers, error mapping, and the active workspace/environment module state.
 *
 * IMPORTANT: the active workspace/environment live in module-level `let`s — this
 * module must stay a SINGLE instance. Every consumer imports it (directly or via
 * the ../api barrel), so the state is shared across all domain fragments.
 *
 * Auth: every call carries a bearer token — a fresh Firebase ID token when the
 * user is signed in, else the pasted `nry_` API token (see getBearerToken). The
 * server resolves tenantId from the token, so the client never sends it.
 */
import { getBearerToken } from "../firebase-lazy";

/** Thrown on a 401 so screens can prompt the user to set their API token. */
export class UnauthorizedError extends Error {
  constructor() {
    super("Not authenticated — set your API token on the sign-in screen.");
    this.name = "UnauthorizedError";
  }
}

/** Thrown on any other non-2xx: carries the HTTP `status` (e.g. 409 conflict on an
 *  already-invited email) and the server's `message` when the body had one, so screens
 *  can branch on status / surface the server's wording instead of a generic error. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly serverMessage?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Thrown when the server's access allowlist rejects this (authenticated) user — the SPA
 *  shows a "not available yet" screen. Distinct from a generic 403 (membership/tenant). */
export class AccessNotAllowedError extends Error {
  constructor(message?: string) {
    super(message ?? "Your account doesn't have access yet.");
    this.name = "AccessNotAllowedError";
  }
}

/** Thrown when the instance requires two-factor auth (#457) and this session has none — the
 *  SPA shows the "enrol to continue" screen. Distinct from a generic 403 (membership/tenant)
 *  AND from a 401: the credentials are valid, so signing the user out would just loop them
 *  back through the same single-factor login. */
export class MfaRequiredError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "This instance requires two-factor authentication. Enrol a second factor, then sign in again.",
    );
    this.name = "MfaRequiredError";
  }
}

export const BASE = "/api";

/**
 * Every API request goes out with `cache: "no-store"` (#1038).
 *
 * The API is authenticated, per-tenant and environment-scoped; none of it is safely reusable from
 * a cache. Production nonetheless answered `GET /executions` with a **304 Not Modified** — the API
 * sent an `ETag` (Express's default) and no `Cache-Control`, which makes a response heuristically
 * cacheable, so the browser revalidated. `fetch()` does NOT transparently serve the cached copy on
 * a 304 the way a document load does: it hands the bare, body-less 304 straight to the caller, and
 * `Response.ok` is false for it — so it fell into the error branch meant for 4xx/5xx.
 *
 * `no-store` means the request is never conditional in the first place. The server-side fix (no
 * `ETag`, `Cache-Control: no-store`) removes the other half; this is the client's own guard.
 */
const NO_STORE: RequestCache = "no-store";
/** The retry's cache mode: bypass every cache and force a full response. */
const RELOAD: RequestCache = "reload";

/** Only a safe, idempotent method may be re-issued — a POST must never be sent twice. */
function isSafeMethod(method?: string): boolean {
  const m = (method ?? "GET").toUpperCase();
  return m === "GET" || m === "HEAD";
}

/**
 * The error a 304 produces once the retry has also failed. A 304 carries no body by definition, so
 * there is nothing to hand a caller that asked for data — but the caller MUST be told, and told
 * why: silently resolving with `undefined` would crash a screen mid-render, and the old bare
 * `HttpError(304)` (no message at all) left nothing to show or report.
 */
export const NOT_MODIFIED_REASON =
  "The server answered 304 Not Modified. A 304 has no body, and nothing was cached here to show " +
  "instead — a cache or proxy in front of the API is answering a request that must not be cached.";

/** Build that error, appending the request context (which route, which status). */
export function notModifiedError(context: string): HttpError {
  return new HttpError(`${NOT_MODIFIED_REASON} (${context})`, 304);
}

// The active workspace, sent as `X-Workspace-Id` so the server scopes every request to the
// selected workspace (multi-workspace model). The WorkspaceProvider sets this once it has
// resolved the caller's workspaces; it's persisted so a reload keeps the selection. When
// unset (fresh signup, or an nry_ token with a single workspace) the server falls back to
// the caller's sole/claim workspace.
// localStorage can THROW (disabled, sandboxed iframe, private mode) — and this runs at module
// init + on every workspace/env change, so a throw would break the whole API client. Wrap it.
function lsGet(key: string): string | null {
  try {
    return typeof localStorage !== "undefined"
      ? localStorage.getItem(key)
      : null;
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable — in-memory state still works for the session */
  }
}

const WORKSPACE_KEY = "naary.workspace";
let activeWorkspaceId: string | null = lsGet(WORKSPACE_KEY);

/** Set (or clear) the active workspace id sent on every subsequent request. Switching to a
 *  DIFFERENT workspace clears the active environment (environments are per-workspace — a stale
 *  X-Environment-Id from the previous workspace must not leak into the new one). */
export function setActiveWorkspace(id: string | null): void {
  if (id !== activeWorkspaceId) setActiveEnvironment(null);
  activeWorkspaceId = id;
  lsSet(WORKSPACE_KEY, id);
}

/** The active workspace id, or null if none selected yet. */
export function getActiveWorkspace(): string | null {
  return activeWorkspaceId;
}

// The active ENVIRONMENT (sandbox/UAT/prod), sent as `X-Environment-Id` so the server scopes a
// request within the active workspace (design docs/design/ENVIRONMENTS.md). Env is per-workspace,
// so switching workspaces clears it (the provider re-resolves). Unset → the server's default env.
const ENVIRONMENT_KEY = "naary.environment";
let activeEnvironmentId: string | null = lsGet(ENVIRONMENT_KEY);

// Subscribers notified when the active environment changes — lets the UI re-render + re-fetch under
// the new X-Environment-Id WITHOUT a full page reload (see useActiveEnvironment + AppShell's keyed
// Outlet). A plain Set so this stays framework-agnostic; React subscribes via useSyncExternalStore.
const envListeners = new Set<() => void>();

/** Set (or clear) the active environment slug/id sent on every subsequent request. Notifies subscribers. */
export function setActiveEnvironment(idOrSlug: string | null): void {
  if (idOrSlug === activeEnvironmentId) return;
  activeEnvironmentId = idOrSlug;
  lsSet(ENVIRONMENT_KEY, idOrSlug);
  for (const l of envListeners) l();
}

/** The active environment id/slug, or null if none selected yet. */
export function getActiveEnvironment(): string | null {
  return activeEnvironmentId;
}

/** Subscribe to active-environment changes. Returns an unsubscribe fn. */
export function subscribeActiveEnvironment(onChange: () => void): () => void {
  envListeners.add(onChange);
  return () => envListeners.delete(onChange);
}

export async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getBearerToken();
  const url = `${BASE}${path}`;
  const requestInit: RequestInit = {
    ...init,
    cache: NO_STORE,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(activeWorkspaceId ? { "x-workspace-id": activeWorkspaceId } : {}),
      ...(activeEnvironmentId
        ? { "x-environment-id": activeEnvironmentId }
        : {}),
      ...init?.headers,
    },
  };
  let res = await fetch(url, requestInit);
  // A 304 from a request we asked NOT to be cached can only come from something in front of the
  // API (proxy/CDN). Ask once more, past every cache, so the caller gets the data it wanted rather
  // than an error about plumbing. Safe methods only — a POST must not be replayed.
  if (res.status === 304 && isSafeMethod(init?.method)) {
    res = await fetch(url, { ...requestInit, cache: RELOAD });
  }
  if (res.status === 401) throw new UnauthorizedError();
  // Checked BEFORE `!res.ok` (which is true for 3xx as well as 4xx/5xx): a 304 has no body, so the
  // error branch below would `res.json()` on nothing, swallow the rejection, and throw a
  // message-less HttpError. The screen must get a stated reason instead.
  if (res.status === 304) {
    throw notModifiedError(`${init?.method ?? "GET"} ${path} → 304`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      code?: string;
      message?: string | string[];
    } | null;
    // A 403 carrying the access-allowlist marker → a specific error (the NotAvailable screen).
    // Only this exact code, so an ordinary 403 (membership/tenant) still surfaces generically.
    if (res.status === 403 && body?.code === "access_not_allowed") {
      throw new AccessNotAllowedError(
        typeof body.message === "string" ? body.message : undefined,
      );
    }
    // A 403 carrying the MFA marker → the enrol-to-continue screen (#457). Same "exact code
    // only" rule, so an ordinary 403 stays generic.
    if (res.status === 403 && body?.code === "mfa_required") {
      throw new MfaRequiredError(
        typeof body.message === "string" ? body.message : undefined,
      );
    }
    // Nest's message can be a string or a class-validator string[] — take the first.
    const serverMessage = Array.isArray(body?.message)
      ? body?.message[0]
      : body?.message;
    // Put the SERVER'S REASON in `message`, not only in `serverMessage`.
    //
    // Reported as `POST /graphs/x/nodes/hasincidents/test → 404` with no reason — while the API
    // had answered "No node 'hasincidents' in this graph", which is the entire diagnosis. The
    // explanation was reachable at `e.serverMessage`, and exactly six call sites in the app
    // unwrap it; everywhere else renders `e.message` and shows a bare status. That is the wrong
    // default: a caller has to opt IN to being told what happened.
    //
    // The request context stays appended because it is what makes an error reportable (which
    // route, which id, which status), and the six existing `serverMessage` readers are unaffected.
    const context = `${init?.method ?? "GET"} ${path} → ${res.status}`;
    const detail =
      typeof serverMessage === "string" && serverMessage.trim()
        ? serverMessage.trim()
        : undefined;
    throw new HttpError(
      detail ? `${detail} (${context})` : context,
      res.status,
      detail,
    );
  }
  // 204 / empty body (e.g. DELETE) — nothing to parse.
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

/**
 * POST to an /introspect endpoint. Hand-rolled (not http()) so the server's specific 400 message
 * (bad URL, non-JSON spec, blocked host, non-2xx upstream) surfaces to the user instead of a generic
 * "→ 400". Carries the same bearer + workspace/env headers as http(). `headers` (an OPTIONAL token
 * the user pastes for a private spec) is forwarded VERBATIM by the server — it never resolves
 * `{{ $secrets }}`, so a stored-secret reference would arrive as a literal string and fail; the UI
 * offers its own token field instead.
 */
export async function introspectFetch<T>(
  path: string,
  url: string,
  headers?: Record<string, string>,
): Promise<T> {
  return introspectPost<T>(path, { url, ...(headers ? { headers } : {}) });
}

/**
 * The body-shaped form of the above, for `/introspect/sql`, whose request names a saved
 * `connectionId` rather than a URL (the DSN is a secret and is resolved server-side — it never
 * reaches the browser, so there is nothing for the caller to pass).
 */
export async function introspectPost<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const token = await getBearerToken();
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    cache: NO_STORE,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(activeWorkspaceId ? { "x-workspace-id": activeWorkspaceId } : {}),
      ...(activeEnvironmentId
        ? { "x-environment-id": activeEnvironmentId }
        : {}),
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new UnauthorizedError();
  // Same 3xx blind spot as http() above: `!res.ok` is true for a 304, whose empty body would leave
  // the user with "Introspection failed (304)" and no idea why. Not retried — this is a POST.
  if (res.status === 304) throw new Error(NOT_MODIFIED_REASON);
  if (!res.ok) {
    const parsed = (await res.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(parsed?.message ?? `Introspection failed (${res.status}).`);
  }
  return res.json() as Promise<T>;
}
