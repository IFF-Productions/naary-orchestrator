import { getByPath } from "./mcp-args";
import type { HttpMethod, HttpRequestNodeConfig } from "./types";

/**
 * An httpRequest node's concrete request after binding resolution — the plain
 * object the `callHttpRequest` activity receives. No I/O, no secrets: the auth
 * header is attached later, inside the activity, from `connectionId`.
 */
export interface ResolvedHttpRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body?: unknown;
  connectionId?: string;
  failOnErrorStatus?: boolean;
  timeoutMs?: number;
  costUsd?: number;
}

/**
 * Set a value at a dotted path within a plain object, creating intermediate
 * objects as needed. Mutates `root` — callers pass a fresh copy. Pure + total.
 */
function setByPath(
  root: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  let cur = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

/**
 * Resolve an httpRequest node's concrete request from the run context (the map of
 * node id → that node's output). Static config is the base; each `argumentBindings`
 * entry overrides the value at its dotted field path (e.g. "url", "body.userId",
 * "query.q", "headers.X-Trace") with the upstream value. This is graph-traversal
 * work (CLAUDE.md: the workflow decides from prior outputs), so it runs in the
 * interpreter and stays deterministic — pure ctx path-reads, no I/O.
 */
export function resolveHttpRequest(
  config: HttpRequestNodeConfig,
  ctx: Record<string, unknown>,
): ResolvedHttpRequest {
  const resolved: Record<string, unknown> = {
    method: config.method,
    url: config.url,
    headers: { ...(config.headers ?? {}) },
    query: { ...(config.query ?? {}) },
    // Clone the body so a `body.*` binding can't deep-mutate the source config
    // (the graph definition held in workflow memory). JSON round-trip keeps this
    // pure + deterministic; the body is JSON-destined anyway.
    body:
      config.body !== null && typeof config.body === "object"
        ? (JSON.parse(JSON.stringify(config.body)) as unknown)
        : config.body,
    connectionId: config.connectionId,
    failOnErrorStatus: config.failOnErrorStatus,
    timeoutMs: config.timeoutMs,
    costUsd: config.costUsd,
  };
  for (const [path, binding] of Object.entries(config.argumentBindings ?? {})) {
    setByPath(resolved, path, getByPath(ctx[binding.from], binding.path));
  }
  return resolved as unknown as ResolvedHttpRequest;
}
