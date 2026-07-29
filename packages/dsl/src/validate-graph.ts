/**
 * Structural graph validation — the SAVE GATE (#910).
 *
 * Split out of `branch.ts` deliberately. `branch.ts` holds `evaluateCondition` +
 * `nextNodes`, which the interpreter calls on every node transition, so it is loaded
 * into the DETERMINISTIC Temporal workflow bundle. `validateGraph` is the only thing in
 * there that needs the 161KB integration catalog, and it never runs inside a workflow —
 * the control plane calls it before `workflow.start`. Keeping them in one module meant
 * `require("./branch")` pulled `./integrations` (every provider, action, and UI hint
 * string) into the bundle every worker loads and every replay evaluates.
 *
 * Pure + deterministic like the rest of the DSL, but NOT workflow-safe by weight: this
 * module is intentionally absent from `./workflow`, the deterministic-safe entry.
 */
import { getIntegrationAction, getIntegrationProvider } from "./integrations";
import { validateHandoffs } from "./handoff";
import { computeItemsRegions } from "./items-region";
import type { GraphDef, IntegrationNodeConfig } from "./types";

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
