/**
 * The two integration helpers that are CATALOG-FREE (#910).
 *
 * `resolveIntegrationFields` is pure graph traversal that the interpreter runs on every
 * integration node, so it is loaded into the deterministic Temporal workflow bundle.
 * While it lived in `integrations.ts` it dragged all 38 providers — every action, every
 * field, every UI hint string, ~161KB — in with it (the package barrel is CJS
 * `__exportStar`, so nothing tree-shakes; only the IMPORT PATH decides what loads).
 *
 * Dependency direction is deliberate and must stay this way: `integrations.ts` imports
 * FROM here (`isEmptyFieldValue`), never the reverse. This module may only import
 * `./types` (erased) and `./mcp-args` (tiny).
 */
import {
  bindingNamesSource,
  getByPath,
  hasForbiddenPathSegment,
} from "./mcp-args";
import type { ArgBinding, IntegrationNodeConfig } from "./types";

/** Resolve a node's concrete field values from the run context — static `fields` are the
 *  base, each `fieldBindings` entry overrides its key with `getByPath(ctx[from], path)`.
 *  Mirrors resolveMcpArguments; pure graph-traversal, runs in the interpreter. */
export function resolveIntegrationFields(
  config: IntegrationNodeConfig,
  ctx: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(config.fields ?? {}) };
  for (const [name, binding] of Object.entries(config.fieldBindings ?? {})) {
    if (hasForbiddenPathSegment(name)) continue; // #591: never assign prototype-chain keys
    // A row that names no source is an unfinished edit, not "blank this field" — see
    // bindingNamesSource. Without this, a typed-in value is silently replaced by undefined.
    if (!bindingNamesSource(binding)) continue;
    const b = binding as ArgBinding;
    out[name] = getByPath(ctx[b.from], b.path);
  }
  return out;
}

/** A field value that carries nothing to send: unset, blank, empty array, or empty object.
 *  Shared by request construction (omit it) and validation (treat as missing) so they agree. */
export function isEmptyFieldValue(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}
