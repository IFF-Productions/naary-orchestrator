import { getByPath } from "./mcp-args";
import type { JsonNodeConfig } from "./types";

/**
 * Resolve a `json` node. `stringify` → `{ json: string }` (indent for pretty-print);
 * `parse` → the parsed value (object/array/primitive). PURE + deterministic
 * (JSON.parse/stringify are ES built-ins available in the workflow sandbox). A malformed
 * string on `parse` throws — a deterministic node failure the graph can handle via
 * `onError: "continue"` (→ `{ error }`) or a workflow error handler.
 */
export function resolveJson(
  config: JsonNodeConfig,
  ctx: Record<string, unknown>,
): unknown {
  const value = getByPath(ctx[config.from], config.path);
  if (config.operation === "stringify") {
    return { json: JSON.stringify(value, null, config.indent ?? 0) };
  }
  return JSON.parse(String(value));
}
