import { getByPath, hasForbiddenPathSegment } from "./mcp-args";
import type { SetNodeConfig } from "./types";

/**
 * Set a value at a dotted path within a plain object, creating intermediate
 * objects as needed. Mutates `root` — callers pass a fresh copy. Pure + total.
 * (Same shape as the httpRequest resolver's helper; kept local so the modules
 * stay independent.)
 */
function setByPath(
  root: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  if (hasForbiddenPathSegment(path)) return; // #591: a `__proto__`/`constructor`/`prototype` segment would pollute the shared isolate's prototypes
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
 * Resolve a `set` node's output object from the run context (node id → output).
 * `fields` is the static base; each `fieldBindings` entry overrides the value at
 * its dotted path with the resolved upstream value. Replace-only: the returned
 * object is the node's entire output — no implicit merge with any input.
 *
 * This is deterministic graph-traversal work (pure ctx path-reads, no I/O), so it
 * runs in the interpreter (CLAUDE.md: the workflow decides from prior outputs).
 * The base is deep-cloned (JSON round-trip) so a `fields.*` binding can't mutate
 * the in-memory graph definition — same guard as `resolveHttpRequest`.
 */
export function resolveSet(
  config: SetNodeConfig,
  ctx: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = config.fields
    ? (JSON.parse(JSON.stringify(config.fields)) as Record<string, unknown>)
    : {};
  for (const [path, binding] of Object.entries(config.fieldBindings ?? {})) {
    setByPath(out, path, getByPath(ctx[binding.from], binding.path));
  }
  return out;
}
