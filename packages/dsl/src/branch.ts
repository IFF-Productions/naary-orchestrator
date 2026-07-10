import { computeItemsRegions } from "./items-region";
import { getByPath } from "./mcp-args";
import type { EdgeCondition, GraphDef } from "./types";

/**
 * Pure, deterministic branching for the interpreter (Slice #6). No time, random,
 * I/O, eval, or `new Function` — these run INSIDE the Temporal workflow and are
 * replay-sensitive (CLAUDE.md Tier-1 rule 2). Predicates are structured DATA.
 */

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
    case "regex":
      if (actual == null) return false;
      try {
        return new RegExp(String(cond.value)).test(String(actual));
      } catch {
        return false; // invalid pattern never fails the run
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
  const region = computeItemsRegions(graph);
  const regionMergeIds = new Set<string>();
  for (const r of region.regions) {
    for (const id of r.regionNodeIds) {
      if (graph.nodes.find((n) => n.id === id)?.type === "merge") {
        regionMergeIds.add(id);
      }
    }
  }
  const mergeIds = new Set(
    graph.nodes.filter((n) => n.type === "merge").map((n) => n.id),
  );
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
  return { valid: true };
}
