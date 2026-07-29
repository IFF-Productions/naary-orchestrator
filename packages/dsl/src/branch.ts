import { getByPath } from "./mcp-args";
import type { EdgeCondition, GraphDef } from "./types";

/**
 * Pure, deterministic branching for the interpreter (Slice #6). No time, random,
 * I/O, eval, or `new Function` — these run INSIDE the Temporal workflow and are
 * replay-sensitive (CLAUDE.md Tier-1 rule 2). Predicates are structured DATA.
 *
 * KEEP THIS MODULE'S IMPORTS TINY (#910). Every node transition calls `nextNodes`, so
 * this file is loaded into the deterministic workflow bundle — and whatever it requires
 * comes with it. The save-gate `validateGraph` used to live here and dragged the 161KB
 * integration catalog in behind it; it now lives in `./validate-graph`.
 */

/**
 * ReDoS guard for the `regex` operator (#598): the pattern is author-controlled and
 * runs in DETERMINISTIC WORKFLOW CODE against upstream data — a catastrophic-
 * backtracking pattern stalls the workflow thread (Temporal deadlock detector /
 * worker-slot starvation), and no timeout can interrupt a sync RegExp. An re2-style
 * engine can't be used here (native modules can't load in the workflow isolate), so
 * we bound the blast radius instead: cap pattern + input size and reject patterns
 * with a quantified group that itself contains a quantifier (star height > 1 — the
 * `(a+)+` family, the classic exponential shape). Deterministic: pure string checks.
 */
const MAX_REGEX_PATTERN_LENGTH = 250;
const MAX_REGEX_INPUT_LENGTH = 10_000;

export function hasNestedQuantifier(pattern: string): boolean {
  // Neutralize escapes and character classes so their contents can't read as
  // quantifiers/groups ("\(" or "[+*]" are literals).
  const stripped = pattern.replace(/\\./g, "x").replace(/\[[^\]]*\]/g, "x");
  const stack: boolean[] = [];
  let cur: boolean = false; // does the CURRENT group level contain a quantifier?
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i];
    if (c === "(") {
      stack.push(cur);
      cur = false;
    } else if (c === ")") {
      const inner: boolean = cur;
      cur = stack.pop() ?? false;
      const next = stripped[i + 1];
      // An OUTER `?` is NOT dangerous: `(a+)?` matches the group 0-or-1× → linear
      // backtracking, not exponential. Only `*`/`+`/`{n,}` around a quantified group
      // drive catastrophic backtracking.
      if (inner && (next === "*" || next === "+" || next === "{")) return true;
      cur = cur || inner;
    } else if (c === "*" || c === "+" || c === "{" || c === "?") {
      // `?` counts as an INNER quantifier: `(a?)+` is a classic exponential form.
      cur = true;
    }
  }
  return false;
}

/** Empty = null/undefined, empty string, empty array, or object with no own keys. */
function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

/**
 * Evaluate one structured edge predicate against the run context. PURE + deterministic:
 * value/string/number/emptiness checks plus a `regex` test (`RegExp` is deterministic; an
 * invalid pattern → false, never a throw that would fail the workflow task). String ops
 * coerce non-string actuals to string so a number/boolean still compares sensibly.
 */
export function evaluateCondition(
  cond: EdgeCondition,
  ctx: Record<string, unknown>,
): boolean {
  const actual = getByPath(ctx, cond.path);
  switch (cond.op) {
    case "eq":
      return actual === cond.value;
    case "neq":
      return actual !== cond.value;
    case "exists":
      return actual !== undefined && actual !== null;
    case "in":
      return Array.isArray(cond.value) && cond.value.includes(actual);
    case "gt":
      return typeof actual === "number" && actual > (cond.value as number);
    case "lt":
      return typeof actual === "number" && actual < (cond.value as number);
    case "gte":
      return typeof actual === "number" && actual >= (cond.value as number);
    case "lte":
      return typeof actual === "number" && actual <= (cond.value as number);
    case "contains":
      if (typeof actual === "string")
        return actual.includes(String(cond.value));
      if (Array.isArray(actual)) return actual.includes(cond.value);
      return false;
    case "notContains":
      if (typeof actual === "string")
        return !actual.includes(String(cond.value));
      if (Array.isArray(actual)) return !actual.includes(cond.value);
      return true; // a missing/non-collection value does not contain the target
    case "startsWith":
      return actual != null && String(actual).startsWith(String(cond.value));
    case "endsWith":
      return actual != null && String(actual).endsWith(String(cond.value));
    case "regex": {
      if (actual == null) return false;
      const pattern = String(cond.value);
      const input = String(actual);
      // Fail closed (false) on anything the guard can't vouch for — same contract
      // as an invalid pattern, and deterministic across replays.
      if (
        pattern.length > MAX_REGEX_PATTERN_LENGTH ||
        input.length > MAX_REGEX_INPUT_LENGTH ||
        hasNestedQuantifier(pattern)
      ) {
        return false;
      }
      try {
        return new RegExp(pattern).test(input);
      } catch {
        return false; // invalid pattern never fails the run
      }
    }
    case "isEmpty":
      return isEmptyValue(actual);
    case "notEmpty":
      return !isEmptyValue(actual);
    default:
      return false;
  }
}

/**
 * The next node ids to run after `nodeId`: every outgoing edge whose condition
 * passes (unconditional edges always pass), in DECLARED edge order. 0 = end of
 * this chain; 1 = sequential/branch; >1 = parallel fan-out.
 */
export function nextNodes(
  graph: GraphDef,
  nodeId: string,
  ctx: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  for (const edge of graph.edges) {
    if (edge.from !== nodeId) continue;
    if (!edge.condition || evaluateCondition(edge.condition, ctx)) {
      out.push(edge.to);
    }
  }
  return out;
}
