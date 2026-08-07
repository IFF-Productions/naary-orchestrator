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

/**
 * `<your-board-id>` — an ANGLE-BRACKET SLOT standing in for a value nobody supplied.
 *
 * A placeholder is worse than a blank, which is the whole reason this exists. Blank is a state the
 * product understands: the save gate names the field, the canvas issues panel lists it, the config
 * panel shows it empty. `<your-twilio-number>` is a non-empty string, so `isEmptyFieldValue` calls
 * it supplied, every check passes, the node LOOKS configured — and the run posts the literal
 * fourteen characters to Twilio and gets a 400. Measured on the AI builder (this module's first
 * caller): 8 of 9 generations of a request that didn't state the values wrote one of these, and not
 * one was reported anywhere before the run.
 *
 * DELIBERATELY ANCHORED AND NARROW. It matches a value that is ENTIRELY one bracketed
 * lowercase-word token — `<board id>`, `<your-notion-database-id>`, `<TWILIO_SID>` — and nothing
 * else. Markup keeps working because markup is never the whole value (`<b>bold</b>` has content
 * after the tag) and Slack's link syntax carries `:`/`/`/`|`, none of which are in the token class.
 * The rule is "you left a slot here", not "this string contains angle brackets".
 */
const PLACEHOLDER_SLOT = /^<[A-Za-z][A-Za-z0-9]*(?:[ _-][A-Za-z0-9]+)*>$/;

/**
 * A value with NOTHING IN IT ANYWHERE — `""`, `[]`, `{}`, and also `{ "database_id": "" }`.
 *
 * `isEmptyFieldValue` stops at the top level, which is right for the request builder (it decides
 * whether to send the key) and wrong for the save gate. A required `json` field arrives as a shape
 * with its values still to fill: Notion's `parent` is `{ "database_id": "" }` — one key, so "not
 * empty", so "supplied" — and the run POSTs a page into a database with no id. Measured directly:
 * once the generator stopped writing `<your-notion-database-id>` it started writing `""` in the
 * same slot, and without this the outcome for the author was identical.
 *
 * PARTIALLY filled is supplied, deliberately. `{ "boardId": "", "itemName": "{{ hook.name }}" }` is
 * a judgement call we cannot make — the catalog describes the field, never the shape inside it, so
 * there is no way to know `boardId` is the load-bearing one. Only "the author filled in nothing at
 * all" is a fact we can state.
 */
export function isBlankFieldValue(v: unknown): boolean {
  if (Array.isArray(v)) return v.every(isBlankFieldValue);
  if (v && typeof v === "object")
    return Object.values(v as Record<string, unknown>).every(isBlankFieldValue);
  return isEmptyFieldValue(v);
}

/**
 * The first placeholder slot anywhere in a field value, or null. Recurses, because a `json` field
 * hides them one level down — Notion's `parent` arrives as `{ "database_id": "<your-database-id>" }`
 * and monday's `variables` as `{ "boardId": "<your-board-id>" }`, which a top-level string test
 * would wave straight through.
 *
 * Returns the offending TEXT rather than a boolean so the error can quote it: `<your-database-id>`
 * is itself the clearest possible statement of what the author has to go and find.
 */
export function findPlaceholderFieldValue(v: unknown): string | null {
  if (typeof v === "string")
    return PLACEHOLDER_SLOT.test(v.trim()) ? v.trim() : null;
  if (Array.isArray(v)) {
    for (const item of v) {
      const hit = findPlaceholderFieldValue(item);
      if (hit) return hit;
    }
    return null;
  }
  if (v && typeof v === "object") {
    for (const item of Object.values(v as Record<string, unknown>)) {
      const hit = findPlaceholderFieldValue(item);
      if (hit) return hit;
    }
  }
  return null;
}
