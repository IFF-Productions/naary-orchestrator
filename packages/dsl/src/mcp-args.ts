import type { McpToolNodeConfig } from "./types";

/**
 * Read a dotted path out of a value. `getByPath(obj)` (no path) returns obj.
 * Pure + total — a missing segment yields undefined, never throws. Safe to run
 * inside the deterministic workflow.
 */
export function getByPath(value: unknown, path?: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, value);
}

/**
 * Resolve an mcpTool node's concrete arguments from the run context (the map of
 * node id → that node's output). Static `arguments` are the base; each
 * `argumentBindings` entry overrides its key with the upstream value. This is
 * graph-traversal work (CLAUDE.md: the workflow decides from prior outputs), so
 * it runs in the interpreter and the activity receives a plain arguments object.
 */
export function resolveMcpArguments(
  config: McpToolNodeConfig,
  ctx: Record<string, unknown>,
): Record<string, unknown> {
  const args: Record<string, unknown> = { ...(config.arguments ?? {}) };
  for (const [name, binding] of Object.entries(config.argumentBindings ?? {})) {
    args[name] = getByPath(ctx[binding.from], binding.path);
  }
  return args;
}
