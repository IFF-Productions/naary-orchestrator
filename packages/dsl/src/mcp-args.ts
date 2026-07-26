import type { McpToolNodeConfig } from "./types";

/** One parsed path segment: an object key, an array index, or the `[*]` wildcard. */
type PathSeg =
  | { kind: "key"; key: string }
  | { kind: "index"; index: number }
  | { kind: "wildcard" };

/** Matches a bracket accessor (`[*]` or `[<n>]`) OR a bare dotted key run. */
const SEG_RE = /\[(\*|\d+)\]|([^.[\]]+)/g;

/**
 * Full-path grammar for a bracketed path: a key or bracket accessor, then any run of
 * `.key` / `[<n>]` / `[*]`. Anything else (a stray `[`, unbalanced brackets, non-numeric
 * index like `a[foo]`) fails to match — so we reject it as unresolvable rather than
 * best-effort reinterpreting `a[foo].b` as the dotted `a.foo.b` (Copilot review, #478).
 */
const BRACKET_PATH_RE =
  /^(?:[^.[\]]+|\[(?:\*|\d+)\])(?:\.[^.[\]]+|\[(?:\*|\d+)\])*$/;

/** Parse `a.b[*].c[0]` → key a · key b · wildcard · key c · index 0. Pure; never throws. */
function parsePath(path: string): PathSeg[] {
  const segs: PathSeg[] = [];
  const re = new RegExp(SEG_RE.source, "g"); // own lastIndex
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex.exec loop
  while ((m = re.exec(path)) !== null) {
    if (m[1] === "*") segs.push({ kind: "wildcard" });
    else if (m[1] !== undefined)
      segs.push({ kind: "index", index: Number(m[1]) });
    else segs.push({ kind: "key", key: m[2] });
  }
  return segs;
}

function walkSegs(value: unknown, segs: PathSeg[], i: number): unknown {
  if (i >= segs.length) return value;
  if (value == null) return undefined;
  const seg = segs[i];
  if (seg.kind === "wildcard") {
    // Array projection (#478): map the REST of the path over each element, returning an
    // array. `[*]` over a non-array yields undefined (a missing token, like a bad key) — so
    // `x[*].id` on a scalar resolves to undefined, never a throw. Nested `[*]` nests (array
    // of arrays), the least-surprising compositional rule.
    if (!Array.isArray(value)) return undefined;
    return value.map((el) => walkSegs(el, segs, i + 1));
  }
  if (seg.kind === "index") {
    if (!Array.isArray(value)) return undefined;
    return walkSegs(value[seg.index], segs, i + 1);
  }
  if (typeof value !== "object") return undefined;
  return walkSegs((value as Record<string, unknown>)[seg.key], segs, i + 1);
}

/**
 * Segments that would walk the PROTOTYPE CHAIN instead of own data. A binding key
 * like `__proto__.polluted` makes a path-setter mutate `Object.prototype` in the
 * shared workflow isolate — cross-execution integrity corruption plus replay
 * divergence (issue #591). Every write-side path resolver (setByPath and the flat
 * binding-name assignments) must skip such keys, and the graph save-gate rejects
 * them (`registry.ts`).
 */
const FORBIDDEN_PATH_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** True if any dotted segment of `path` is a prototype-chain key. Pure + total. */
export function hasForbiddenPathSegment(path: string): boolean {
  return path.split(".").some((k) => FORBIDDEN_PATH_SEGMENTS.has(k));
}

/**
 * True if `key` IS a prototype-chain name, treating it as a literal key rather than a dotted path.
 *
 * Separate from `hasForbiddenPathSegment` because the two are asked different questions. A binding is
 * a PATH (`user.__proto__.x` must be refused), whereas a form field key or a rename target is a single
 * literal name that may legitimately contain a dot (`user.email` as one flat key). Splitting such a
 * name on "." would refuse keys that are perfectly safe, so the distinction is kept explicit.
 */
export function isPollutingKey(key: string): boolean {
  return FORBIDDEN_PATH_SEGMENTS.has(key);
}

/**
 * Read a dotted/bracketed path out of a value. `getByPath(obj)` (no path) returns obj.
 * Supports object keys (`a.b`), array indices (`a[0]`), and the array-projection wildcard
 * `a[*].b` (#478) — which maps `.b` over each element of the array `a`. Pure + total — a
 * missing/mismatched segment (or a malformed bracket path) yields undefined, never throws.
 * Safe in the deterministic workflow.
 */
export function getByPath(value: unknown, path?: string): unknown {
  if (!path) return value;
  // Fast path: a plain dotted path (no brackets) — the overwhelmingly common case, and byte-for-
  // byte the pre-#478 behavior (empty segments included), so nothing that worked before shifts.
  if (!path.includes("[")) {
    return path.split(".").reduce<unknown>((acc, key) => {
      if (acc == null || typeof acc !== "object") return undefined;
      return (acc as Record<string, unknown>)[key];
    }, value);
  }
  // A bracket appears → require the WHOLE path to match the accessor grammar. A malformed
  // path (stray/unbalanced bracket, non-numeric index) is unresolvable → undefined, rather
  // than silently dropping the brackets and resolving a different path.
  if (!BRACKET_PATH_RE.test(path)) return undefined;
  return walkSegs(value, parsePath(path), 0);
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
    if (hasForbiddenPathSegment(name)) continue; // #591: never assign prototype-chain keys
    args[name] = getByPath(ctx[binding.from], binding.path);
  }
  return args;
}
