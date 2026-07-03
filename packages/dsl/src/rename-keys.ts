import { getByPath } from "./mcp-args";
import type { RenameKeysNodeConfig } from "./types";

/**
 * Reshape an upstream object: rename listed top-level keys and drop others. Pure,
 * deterministic graph work (ctx path-read, no I/O) — runs in the interpreter. A
 * non-object source yields `{}`. `drop` wins over `rename` when a key is in both.
 */
export function resolveRenameKeys(
  config: RenameKeysNodeConfig,
  ctx: Record<string, unknown>,
): Record<string, unknown> {
  const src = getByPath(ctx[config.from], config.path);
  if (src === null || typeof src !== "object" || Array.isArray(src)) return {};
  const rename = config.rename ?? {};
  const drop = new Set(config.drop ?? []);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
    if (drop.has(k)) continue;
    out[rename[k] ?? k] = v;
  }
  return out;
}
