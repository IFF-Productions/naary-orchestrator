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
import { getBearerToken } from "../firebase";

/** Thrown on a 401 so screens can prompt the user to set their API token. */
export class UnauthorizedError extends Error {
  constructor() {
    super("Not authenticated — set your API token on the sign-in screen.");
    this.name = "UnauthorizedError";
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

export const BASE = "/api";

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
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(activeWorkspaceId ? { "x-workspace-id": activeWorkspaceId } : {}),
      ...(activeEnvironmentId
        ? { "x-environment-id": activeEnvironmentId }
        : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    // A 403 carrying the access-allowlist marker → a specific error (the NotAvailable screen).
    // Only this exact code, so an ordinary 403 (membership/tenant) still surfaces generically.
    if (res.status === 403) {
      const body = (await res.json().catch(() => null)) as {
        code?: string;
        message?: string;
      } | null;
      if (body?.code === "access_not_allowed") {
        throw new AccessNotAllowedError(body.message);
      }
    }
    throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}`);
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
  const token = await getBearerToken();
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(activeWorkspaceId ? { "x-workspace-id": activeWorkspaceId } : {}),
      ...(activeEnvironmentId
        ? { "x-environment-id": activeEnvironmentId }
        : {}),
    },
    body: JSON.stringify({ url, ...(headers ? { headers } : {}) }),
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(body?.message ?? `Introspection failed (${res.status}).`);
  }
  return res.json() as Promise<T>;
}
