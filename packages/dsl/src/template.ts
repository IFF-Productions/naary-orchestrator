import { getByPath } from "./mcp-args";

/**
 * Template-lite expressions (design docs/design/EXPRESSIONS.md). String config fields may embed
 * `{{ nodeId.path }}` tokens that reference an upstream node's output in the run context
 * (`ctx[nodeId]`). This is NOT an expression language — no eval, no arithmetic, just a dotted
 * `getByPath` lookup — so it's pure + deterministic and runs in workflow code (Tier-1 rule 2).
 */

// The whole string is exactly one token → return the TYPED value (object/number/…), not a string.
const WHOLE_RE = /^\{\{\s*([^{}]+?)\s*\}\}$/;
// An escaped literal `\{{` OR a `{{ path }}` token (path has no braces).
const EMBED_RE = /\\\{\{|\{\{\s*([^{}]+?)\s*\}\}/g;

/** Coerce a resolved value for embedding inside surrounding text. */
function embed(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Resolve `{{ … }}` tokens in ONE string against `ctx`. A whole-string token yields the typed
 * value; embedded tokens are substituted (objects → JSON) and the result is a string. A missing
 * path → `undefined` (whole) / `""` (embedded). `\{{` emits a literal `{{`. Total — never throws.
 */
export function resolveTemplateString(
  s: string,
  ctx: Record<string, unknown>,
): unknown {
  if (!s.includes("{{")) return s; // fast path: no tokens
  const whole = WHOLE_RE.exec(s);
  if (whole) return getByPath(ctx, whole[1].trim());
  return s.replace(EMBED_RE, (match, path?: string) =>
    match === "\\{{" ? "{{" : embed(getByPath(ctx, (path ?? "").trim())),
  );
}

/**
 * Deep-resolve `{{ … }}` tokens in every string of a node's config against `ctx`. Returns a new
 * config (arrays + nested objects walked); non-strings and untokened strings pass through
 * unchanged, so it's zero-cost + backward-compatible for graphs that use no templates.
 */
export function resolveTemplates<T>(
  config: T,
  ctx: Record<string, unknown>,
): T {
  return walk(config, ctx) as T;
}

function walk(v: unknown, ctx: Record<string, unknown>): unknown {
  if (typeof v === "string") return resolveTemplateString(v, ctx);
  if (Array.isArray(v)) return v.map((x) => walk(x, ctx));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = walk(val, ctx);
    }
    return out;
  }
  return v;
}
