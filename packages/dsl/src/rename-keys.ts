import { getByPath } from "./mcp-args";
import type { RenameKeysNodeConfig } from "./types";

/**
 * Reshape an upstream object: rename listed top-level keys and drop others. Pure,
 * deterministic graph work (ctx path-read, no I/O) — runs in the interpreter. A
 * non-object source yields `{}`. `drop` wins over `rename` when a key is in both.
 *
 * ## `ownRenameLookup` — the #766 fix, behind a replay gate
 *
 * The original `rename[k] ?? k` reads the PROTOTYPE CHAIN. `rename` is a plain object from graph
 * config, so `rename["constructor"]` doesn't miss — it returns `Object.prototype.constructor`, a
 * FUNCTION, which then stringifies into an output key of `"function Object() { [native code] }"`.
 * Reachable with an entirely innocent config: any upstream object carrying a literal `constructor`
 * field hits it, and arbitrary API responses do (`{"constructor": "Acme Ltd"}` is an ordinary record).
 * `__proto__` and `prototype` as SOURCE keys behave the same way.
 *
 * The fix is `Object.hasOwn`, plus a null-prototype accumulator so a rename TARGET of `__proto__`
 * creates an own key instead of silently setting the prototype and discarding the value.
 *
 * It is OPT-IN because this function runs in deterministic workflow code: changing its output makes an
 * in-flight run replay differently and fail. The caller gates it on `wf.patched()` (CLAUDE.md: version
 * interpreter changes with `workflow.patched()`), so histories that predate the fix keep the old path.
 * Once no pre-gate run can be replayed, the flag and the legacy branch can both go.
 */
export function resolveRenameKeys(
  config: RenameKeysNodeConfig,
  ctx: Record<string, unknown>,
  opts: { ownRenameLookup?: boolean } = {},
): Record<string, unknown> {
  const src = getByPath(ctx[config.from], config.path);
  if (src === null || typeof src !== "object" || Array.isArray(src)) return {};
  const rename = config.rename ?? {};
  const drop = new Set(config.drop ?? []);
  const out: Record<string, unknown> = opts.ownRenameLookup
    ? (Object.create(null) as Record<string, unknown>)
    : {};
  for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
    if (drop.has(k)) continue;
    // `hasOwnProperty.call`, not `Object.hasOwn`: this package targets an older `lib`, and widening
    // it for one call would be a bigger change than the fix.
    const target = opts.ownRenameLookup
      ? Object.prototype.hasOwnProperty.call(rename, k)
        ? rename[k]
        : k
      : (rename[k] ?? k);
    out[target] = v;
  }
  return out;
}
