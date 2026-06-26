import { getByPath } from "./mcp-args";
import type { EdgeCondition, GraphDef } from "./types";

/**
 * Pure, deterministic branching for the interpreter (Slice #6). No time, random,
 * I/O, eval, or `new Function` — these run INSIDE the Temporal workflow and are
 * replay-sensitive (CLAUDE.md Tier-1 rule 2). Predicates are structured DATA.
 */

/** Evaluate one structured edge predicate against the run context. */
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
  for (const edge of graph.edges) {
    if (!ids.has(edge.from)) {
      return { valid: false, error: `edge.from '${edge.from}' is not a node` };
    }
    if (!ids.has(edge.to)) {
      return { valid: false, error: `edge.to '${edge.to}' is not a node` };
    }
  }
  return { valid: true };
}
