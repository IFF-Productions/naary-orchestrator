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
// An escaped literal `\{{` OR a `{{ path }}` token (path has no braces). THE definition — see
// embedRe() below; template-blocks.ts had a byte-identical copy whose comment claimed it was "the
// SAME shape the runtime resolves with", which was a hope rather than a guarantee (#805).
const EMBED_RE = /\\\{\{|\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * A FRESH `{{ … }}` matcher. A factory, not the shared instance, deliberately: the pattern is `/g`,
 * so `exec`/`test` carry `lastIndex` between calls and two modules sharing one instance would
 * interleave into each other's scan position. (`String.replace` is safe — it resets — which is why
 * the local uses below keep using EMBED_RE directly.)
 */
export const embedRe = (): RegExp =>
  new RegExp(EMBED_RE.source, EMBED_RE.flags);

/** A `{{ $secrets.NAME }}` reference. Secret VALUES must never enter the graph/ctx/Temporal history
 *  (CLAUDE.md Tier-1 §4), so — unlike every other token — the workflow does NOT resolve these. They
 *  are left LITERAL by `resolveTemplateString` and skipped by `collectUnresolved`, then resolved
 *  in-memory INSIDE the activity that uses them (e.g. httpRequest headers). `ctx` never holds a
 *  `$secrets` key, so `getByPath` would otherwise blank them (leak-free but non-functional) and the
 *  unresolved-input diagnostic would spuriously flag every secret ref (leaking the NAME to history). */
export function isSecretRef(ref: string): boolean {
  const head = ref.split(".")[0]?.trim();
  return head === "$secrets";
}

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
  if (whole) {
    const path = whole[1].trim();
    // Leave a whole-string `{{ $secrets.NAME }}` LITERAL — the activity resolves it in-memory.
    return isSecretRef(path) ? s : getByPath(ctx, path);
  }
  return s.replace(EMBED_RE, (match, path?: string) => {
    if (match === "\\{{") return "{{";
    const ref = (path ?? "").trim();
    // Preserve embedded `{{ $secrets.NAME }}` verbatim (only the activity may resolve it).
    return isSecretRef(ref) ? match : embed(getByPath(ctx, ref));
  });
}

/** A located `{{ path }}` token — for AUTHORING tools (syntax highlighting / autocomplete). */
export interface TemplateToken {
  /** String offset of the opening `{{`. */
  start: number;
  /** String offset just past the closing `}}`. */
  end: number;
  /** The trimmed inner reference (e.g. `hook.repository.name`). */
  path: string;
}

/**
 * Locate every `{{ path }}` token in a string, using the SAME `EMBED_RE` the runtime resolves
 * with — so an editor's highlighter/autocomplete can never drift from what actually resolves.
 * Escaped `\{{` literals are skipped (they aren't tokens). Pure; never throws.
 */
export function templateTokens(s: string): TemplateToken[] {
  const out: TemplateToken[] = [];
  const re = embedRe(); // own lastIndex; don't mutate the shared instance
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex.exec loop
  while ((m = re.exec(s)) !== null) {
    if (m[0] === "\\{{") continue; // escaped literal `\{{`, not a token
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      path: (m[1] ?? "").trim(),
    });
  }
  return out;
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

/** A RESERVED runtime source is one the run context (or an activity) provides directly, not a graph
 *  node — so a reference to it is always valid and must never be linted as an "unknown node". Kinds:
 *  `__`-prefixed sources (e.g. `__input`; splitOut/loopEnd bind `from: "__input"` for trigger input),
 *  `$vars` (Global Variables — the interpreter seeds `ctx.$vars` at run start), and `$secrets`
 *  (Environment Secrets — resolved IN-ACTIVITY, never in ctx; see [[isSecretRef]]). */
function isReservedSource(from: string): boolean {
  return from.startsWith("__") || from === "$vars" || from === "$secrets";
}

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
      if (refNode && !isReservedSource(refNode) && !nodeIds.has(refNode)) {
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

/**
 * Lint structured `{from, path?}` bindings (fieldBindings / paramBindings / argumentBindings /
 * the bare `*Binding` fields) across a graph — the counterpart to `lintTemplates` for the
 * NON-string binding shape the template linter can't see. Flags a binding whose `from` source
 * isn't a node in the graph, naming WHICH source is missing. Same warning shape as a template
 * warning so the canvas can show both together. WARNING-only (runtime resolves it to empty).
 */
export function lintBindings(graph: GraphDef): TemplateWarning[] {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const warnings: TemplateWarning[] = [];
  for (const node of graph.nodes) {
    walkForBindings(node.config, "", (field, from, path) => {
      if (from && !isReservedSource(from) && !nodeIds.has(from)) {
        warnings.push({
          nodeId: node.id,
          field,
          ref: path ? `${from}.${path}` : from,
          message: `binds from unknown node "${from}" — will always be empty`,
        });
      }
    });
  }
  return warnings;
}

/** An input reference (a `{{ }}` token OR a `{from,path}` binding) that resolved to nothing
 *  when its node ran — i.e. its source produced no output. Diagnostic surfaced on the run detail
 *  so an empty/failed node names WHICH source was missing, instead of looking silently "fine". */
export interface UnresolvedRef {
  /** The node whose input didn't resolve. */
  nodeId: string;
  /** Dotted path to the offending config field, e.g. "fieldBindings.body" or "systemPrompt". */
  field: string;
  /** The source node id the reference reads from. */
  from: string;
  /** The full reference (source + path) for display, e.g. "review.output.review". */
  ref: string;
  /** true → `from` IS a node in the graph, so it ran but produced no output on this branch;
   *  false → `from` isn't a node at all (a typo'd / deleted source). */
  sourceExists: boolean;
}

/**
 * Collect a node's input references that resolve to `undefined` against the CURRENT run context —
 * i.e. the source produced no output. Pure + deterministic (only `getByPath` over `ctx`), so the
 * interpreter can call it in workflow code and stash the result in `ctx.__unresolved` (replay-safe,
 * no Temporal command). Covers BOTH `{{ }}` string tokens and structured `{from,path}` bindings.
 * A reference whose value is present (even `null` / `""`) is NOT reported — only strictly missing.
 */
export function collectUnresolved(
  node: { id: string; config?: unknown },
  ctx: Record<string, unknown>,
  nodeIds: Set<string>,
): UnresolvedRef[] {
  const out: UnresolvedRef[] = [];
  const push = (field: string, from: string, ref: string) => {
    if (from) {
      out.push({
        nodeId: node.id,
        field,
        from,
        ref,
        sourceExists: nodeIds.has(from),
      });
    }
  };
  // `{{ source.path }}` tokens — unresolved when the whole dotted lookup yields undefined.
  walkForTokens(node.config, "", (field, ref) => {
    // A `$secrets.NAME` token is resolved IN-ACTIVITY, never against ctx — so getByPath is always
    // undefined for it. Skip it here, else the secret NAME would ride into ctx.__unresolved → the
    // state query + Temporal history, and every secret-using node would show a false "unresolved".
    if (isSecretRef(ref)) return;
    if (getByPath(ctx, ref) === undefined) {
      push(field, ref.split(".")[0]?.trim() ?? "", ref);
    }
  });
  // `{from, path?}` bindings — unresolved when getByPath(ctx[from], path) is undefined.
  walkForBindings(node.config, "", (field, from, path) => {
    if (from === "$secrets") return; // resolved in-activity (see above)
    if (getByPath(ctx[from], path) === undefined) {
      push(field, from, path ? `${from}.${path}` : from);
    }
  });
  return out;
}

/** Is `v` exactly the ArgBinding shape `{ from: string, path?: string }` — and nothing else?
 *  The "nothing else" guard keeps a plain string field named `from` (e.g. an email sender) from
 *  matching: those are strings, not objects, and any richer object has extra keys. */
function isArgBinding(v: unknown): v is { from: string; path?: string } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.from !== "string") return false;
  return Object.keys(o).every((k) => k === "from" || k === "path");
}

function walkForBindings(
  v: unknown,
  field: string,
  cb: (field: string, from: string, path?: string) => void,
): void {
  if (isArgBinding(v)) {
    // A binding is a leaf — don't recurse into its own from/path strings.
    cb(field, v.from.trim(), typeof v.path === "string" ? v.path : undefined);
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => walkForBindings(x, `${field}[${i}]`, cb));
    return;
  }
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      walkForBindings(val, field ? `${field}.${k}` : k, cb);
    }
  }
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
