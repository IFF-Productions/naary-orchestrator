import { getByPath } from "./mcp-args";
import type { GraphDef } from "./types";

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

/** A `{{ }}` token that references a node id not present in the graph (a likely typo). */
export interface TemplateWarning {
  /** The node whose config contains the token. */
  nodeId: string;
  /** Dotted path to the offending config field, e.g. "headers.X-Cat". */
  field: string;
  /** The referenced path inside the token, e.g. "aget.output.id". */
  ref: string;
  message: string;
}

// A `{{ path }}` token, not escaped. Mirrors resolveTemplateString.
const LINT_RE = /\\\{\{|\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * Lint `{{ nodeId.path }}` tokens across a graph's string config. Flags tokens whose referenced
 * node id isn't a node in the graph — an always-empty reference (a typo). A WARNING, not an error:
 * the run tolerates it (resolves to empty), so this is author-time guidance only.
 */
export function lintTemplates(graph: GraphDef): TemplateWarning[] {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const warnings: TemplateWarning[] = [];
  for (const node of graph.nodes) {
    walkForTokens(node.config, "", (field, ref) => {
      const refNode = ref.split(".")[0]?.trim();
      if (refNode && !nodeIds.has(refNode)) {
        warnings.push({
          nodeId: node.id,
          field,
          ref,
          message: `references unknown node "${refNode}" — will always be empty`,
        });
      }
    });
  }
  return warnings;
}

function walkForTokens(
  v: unknown,
  field: string,
  cb: (field: string, ref: string) => void,
): void {
  if (typeof v === "string") {
    let m: RegExpExecArray | null;
    LINT_RE.lastIndex = 0;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
    while ((m = LINT_RE.exec(v)) !== null) {
      if (m[0] !== "\\{{" && m[1]) cb(field, m[1].trim());
    }
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => walkForTokens(x, `${field}[${i}]`, cb));
    return;
  }
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      walkForTokens(val, field ? `${field}.${k}` : k, cb);
    }
  }
}
