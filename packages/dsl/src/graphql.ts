import { getByPath, hasForbiddenPathSegment } from "./mcp-args";
import type { GraphQLNodeConfig } from "./types";

/**
 * A GraphQL node's concrete request after binding resolution — the plain object the `callGraphQL`
 * activity receives. No I/O, no secrets resolved: `{{ $secrets.NAME }}` tokens are left LITERAL in
 * headers/variables here and resolved in-activity (Tier-1 §4), exactly like httpRequest.
 */
export interface ResolvedGraphQL {
  url: string;
  query: string;
  variables: Record<string, unknown>;
  headers: Record<string, string>;
  failOnErrors?: boolean;
  timeoutMs?: number;
  costUsd?: number;
}

/** Set a value at a dotted path within a plain object, creating intermediates. Mutates `root`
 *  (callers pass a fresh copy). Pure + total. */
function setByPath(
  root: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  if (hasForbiddenPathSegment(path)) return; // #591: prototype-chain keys must never be walked/assigned
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
 * Resolve a GraphQL node's concrete request from the run context. Static config is the base; each
 * `argumentBindings` entry overrides the value at its dotted field path (e.g. "variables.id",
 * "headers.X-Trace", "url") with the upstream value. Graph-traversal work (pure ctx path-reads, no
 * I/O), so it runs in the interpreter and stays deterministic. `variables` is deep-cloned so a
 * `variables.*` binding can't mutate the graph definition held in workflow memory.
 */
export function resolveGraphQL(
  config: GraphQLNodeConfig,
  ctx: Record<string, unknown>,
): ResolvedGraphQL {
  const resolved: Record<string, unknown> = {
    url: config.url,
    query: config.query,
    variables: config.variables
      ? (JSON.parse(JSON.stringify(config.variables)) as Record<
          string,
          unknown
        >)
      : {},
    headers: { ...(config.headers ?? {}) },
    failOnErrors: config.failOnErrors,
    timeoutMs: config.timeoutMs,
    costUsd: config.costUsd,
  };
  for (const [path, binding] of Object.entries(config.argumentBindings ?? {})) {
    setByPath(resolved, path, getByPath(ctx[binding.from], binding.path));
  }
  return resolved as unknown as ResolvedGraphQL;
}
