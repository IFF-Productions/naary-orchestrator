import { getByPath, hasForbiddenPathSegment } from "./mcp-args";
import type { ExecuteSubWorkflowNodeConfig } from "./types";

/**
 * Set a value at a dotted path within a plain object, creating intermediate
 * objects as needed. Mutates `root` — callers pass a fresh copy. Pure + total.
 */
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
 * Resolve the input a `executeSubWorkflow` node passes to its child run, from the
 * run context (node id → output). `input` is the static base; each `inputBindings`
 * entry fills/overrides the value at its dotted path with the upstream value.
 *
 * Returns `undefined` when the node configures NO input at all — the interpreter
 * then forwards the parent's own trigger input to the child (the common case).
 *
 * Pure, deterministic graph work (ctx path-reads, no I/O) — runs in the
 * interpreter. The base is deep-cloned so an `input.*` binding can't mutate the
 * in-memory graph definition (same guard as `resolveSet`/`resolveHttpRequest`).
 */
export function resolveSubWorkflowInput(
  config: ExecuteSubWorkflowNodeConfig,
  ctx: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const bindings = Object.entries(config.inputBindings ?? {});
  if (config.input === undefined && bindings.length === 0) return undefined;
  const out: Record<string, unknown> = config.input
    ? (JSON.parse(JSON.stringify(config.input)) as Record<string, unknown>)
    : {};
  for (const [path, binding] of bindings) {
    setByPath(out, path, getByPath(ctx[binding.from], binding.path));
  }
  return out;
}
