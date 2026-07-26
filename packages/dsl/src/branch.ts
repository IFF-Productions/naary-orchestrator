import { validateHandoffs } from "./handoff";
import { getIntegrationAction, getIntegrationProvider } from "./integrations";
import { computeItemsRegions } from "./items-region";
import { getByPath } from "./mcp-args";
import type { EdgeCondition, GraphDef, IntegrationNodeConfig } from "./types";

/**
 * Pure, deterministic branching for the interpreter (Slice #6). No time, random,
 * I/O, eval, or `new Function` — these run INSIDE the Temporal workflow and are
 * replay-sensitive (CLAUDE.md Tier-1 rule 2). Predicates are structured DATA.
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

export interface GraphValidation {
  valid: boolean;
  error?: string;
}

/**
 * Structural validation (pure) for the control plane to reject a malformed graph
 * BEFORE workflow.start — so a dangling edge or missing start can't wedge a run in
 * retries. Cycles are NOT errors (loops are intentional in Slice #6).
 */
export function validateGraph(graph: GraphDef): GraphValidation {
  const ids = new Set(graph.nodes.map((n) => n.id));
  if (ids.size !== graph.nodes.length) {
    return { valid: false, error: "duplicate node id" };
  }
  if (!ids.has(graph.startNodeId)) {
    return {
      valid: false,
      error: `startNodeId '${graph.startNodeId}' is not a node`,
    };
  }
  // Merge (fan-in join) supports UNCONDITIONAL inbound only: a conditional edge into
  // a merge could fail to fire, stranding the join (it would wait for a branch that
  // never arrives). Reject it here so the footgun can't reach a run (v1 limitation).
  // EXCEPTION: a merge INSIDE an A4 items region (items §0.4.1) is handled by the per-item
  // dead-branch pass, not the top-level walker — its conditional inbound is validated by
  // computeItemsRegions, so exempt those.
  const mergeIds = new Set(
    graph.nodes.filter((n) => n.type === "merge").map((n) => n.id),
  );
  const region = computeItemsRegions(graph);
  const regionMergeIds = new Set<string>();
  for (const r of region.regions) {
    for (const id of r.regionNodeIds) {
      if (mergeIds.has(id)) regionMergeIds.add(id);
    }
  }
  for (const edge of graph.edges) {
    if (!ids.has(edge.from)) {
      return { valid: false, error: `edge.from '${edge.from}' is not a node` };
    }
    if (!ids.has(edge.to)) {
      return { valid: false, error: `edge.to '${edge.to}' is not a node` };
    }
    if (
      edge.condition &&
      mergeIds.has(edge.to) &&
      !regionMergeIds.has(edge.to)
    ) {
      return {
        valid: false,
        error: `conditional edge into merge node '${edge.to}' is not supported (merge requires unconditional fan-in)`,
      };
    }
  }
  // Connectivity: a multi-node graph whose entry node has no outgoing edge is
  // disconnected — the run would do nothing. Catches the AI generator emitting
  // nodes with an empty edges array. Deliberately NARROW (only the start node), not
  // full reachability, so a secondary entry like an errorTrigger isn't flagged.
  if (
    graph.nodes.length > 1 &&
    !graph.edges.some((e) => e.from === graph.startNodeId)
  ) {
    return {
      valid: false,
      error: `startNodeId '${graph.startNodeId}' has no outgoing edge — the graph is disconnected`,
    };
  }
  // Items model: a splitOut…loopEnd region must be a valid bracket (participation is drawn, not
  // inferred — so the whole correctness story is this structural save-time check). Reuse the region
  // computed above for the merge-exemption set.
  if (region.error) return { valid: false, error: region.error };

  // Integration nodes: strict on PRESENT values (like httpRequest's url) — a bogus provider
  // or action (e.g. from a hand-edited or AI-generated graph) is rejected at save. Missing
  // fields stay a draft; the activity does the full required-field check at run time.
  for (const node of graph.nodes) {
    if (node.type !== "integration") continue;
    const cfg = (node.config ?? {}) as Partial<IntegrationNodeConfig>;
    if (cfg.provider && !getIntegrationProvider(cfg.provider)) {
      return {
        valid: false,
        error: `node '${node.id}': unknown integration provider '${cfg.provider}'`,
      };
    }
    if (
      cfg.provider &&
      cfg.action &&
      !getIntegrationAction(cfg.provider, cfg.action)
    ) {
      return {
        valid: false,
        error: `node '${node.id}': unknown action '${cfg.action}' for provider '${cfg.provider}'`,
      };
    }
  }

  // Agent handoff (#580): a supervisor's declared targets must be REAL nodes reached by
  // correctly-conditioned edges. Only graphs that carry the new `handoff` field are
  // checked, so nothing already saved can newly fail. See handoff.ts for why each rule
  // exists — chiefly that an unconditional target edge would fan out on every run.
  const handoffError = validateHandoffs(graph);
  if (handoffError) return { valid: false, error: handoffError };

  return { valid: true };
}
