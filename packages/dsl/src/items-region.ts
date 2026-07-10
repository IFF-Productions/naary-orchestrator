/**
 * Items model (design ITEMS-MODEL-CURRENT-ITEM.md §0.2) — the fail-closed region linchpin.
 *
 * A `splitOut … loopEnd` pair brackets a per-item region: the linear chain of nodes between them
 * runs once per array element. Participation is DRAWN (the bracket), never inferred — so the whole
 * correctness story reduces to validating the drawn region STRUCTURALLY at save time, where a bad
 * graph is a correctable 400 rather than a frozen runtime corruption.
 *
 * `computeItemsRegions` is the single source of truth: the save-time validator and the interpreter
 * both call it, so they can never disagree about what a region is.
 */
import { isPureNode } from "./pure-node";
import type { EdgeDef, GraphDef } from "./types";

export interface ItemsRegion {
  splitOutId: string;
  loopEndId: string;
  /** The linear region nodes, in execution order (excludes splitOut + loopEnd). May be empty. */
  regionNodeIds: string[];
  /** The node whose per-iteration output `loopEnd` collects (a region node, or the splitOut). */
  collectFrom: string;
}

export interface ItemsRegionResult {
  regions: ItemsRegion[];
  /** First structural violation (node id named), or null when every region is valid. */
  error: string | null;
}

/** Node types allowed inside an A2 region: pure nodes (no I/O, deterministic) + the no-op. A2
 *  regions run N times with a single signal handler, so durable/activity nodes are rejected. */
function regionAllowed(type: string): boolean {
  return isPureNode(type) || type === "noOp";
}

/**
 * Compute + validate every `splitOut` region by a purely structural walk (no bindings inspected):
 * from each `splitOut`, follow the unique linear chain of allowed nodes to its `loopEnd`. Any
 * branch/join, non-pure node, nested splitOut/loopEnd, missing/duplicate loopEnd, or dangling
 * `loopEnd` is a save-time error. Deterministic + pure — safe for both the API save-gate and the
 * interpreter precompute.
 */
export function computeItemsRegions(graph: GraphDef): ItemsRegionResult {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  // Precompute adjacency ONCE (O(edges)) so the per-splitOut walk is O(1) lookups, not repeated
  // full-edge scans — this also runs in the interpreter precompute, so keep it linear.
  const outEdges = new Map<string, EdgeDef[]>();
  const inEdges = new Map<string, EdgeDef[]>();
  for (const e of graph.edges) {
    (outEdges.get(e.from) ?? outEdges.set(e.from, []).get(e.from)!).push(e);
    (inEdges.get(e.to) ?? inEdges.set(e.to, []).get(e.to)!).push(e);
  }
  const outFrom = (id: string): string[] =>
    (outEdges.get(id) ?? []).map((e) => e.to);
  const inTo = (id: string): string[] =>
    (inEdges.get(id) ?? []).map((e) => e.from);
  /** True if `id`'s outgoing edge carries a condition. The region runs its body UNCONDITIONALLY
   *  once per item, so a conditional edge inside it would be silently ignored — reject it at save
   *  (the interpreter never evaluates intra-region conditions). */
  const hasConditionalOut = (id: string): boolean =>
    (outEdges.get(id) ?? []).some((e) => e.condition !== undefined);

  const regions: ItemsRegion[] = [];
  const claimedLoopEnds = new Set<string>();
  const err = (msg: string): ItemsRegionResult => ({ regions, error: msg });

  for (const n of graph.nodes) {
    if (n.type !== "splitOut") continue;

    const outs = outFrom(n.id);
    if (outs.length !== 1) {
      return err(`splitOut '${n.id}' must have exactly one outgoing edge`);
    }
    if (hasConditionalOut(n.id)) {
      return err(
        `splitOut '${n.id}' has a conditional outgoing edge — region edges must be unconditional`,
      );
    }
    const regionNodeIds: string[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = outs[0];

    while (true) {
      if (cur === undefined) {
        return err(`splitOut '${n.id}' has no matching loopEnd on its path`);
      }
      const node = nodeById.get(cur);
      if (!node)
        return err(`splitOut '${n.id}' path reaches unknown node '${cur}'`);
      if (node.type === "loopEnd") break;

      if (node.type === "splitOut") {
        return err(
          `nested splitOut '${cur}' inside region of '${n.id}' (not supported in v1)`,
        );
      }
      if (!regionAllowed(node.type)) {
        return err(
          `node '${cur}' (${node.type}) is not allowed inside a splitOut region — regions are pure nodes only in v1`,
        );
      }
      if (inTo(cur).length !== 1) {
        return err(
          `region node '${cur}' has a join (must be a linear chain in v1)`,
        );
      }
      if (outFrom(cur).length !== 1) {
        return err(
          `region node '${cur}' has a branch (must be a linear chain in v1)`,
        );
      }
      if (hasConditionalOut(cur)) {
        return err(
          `region node '${cur}' has a conditional outgoing edge — region edges must be unconditional (the body runs per item unconditionally)`,
        );
      }
      if (seen.has(cur))
        return err(`cycle in splitOut '${n.id}' region at '${cur}'`);
      seen.add(cur);
      regionNodeIds.push(cur);
      cur = outFrom(cur)[0];
    }

    const loopEndId = cur; // the loopEnd that terminated the walk
    if (claimedLoopEnds.has(loopEndId)) {
      return err(`loopEnd '${loopEndId}' is claimed by more than one splitOut`);
    }
    if (inTo(loopEndId).length !== 1) {
      return err(`loopEnd '${loopEndId}' must have exactly one incoming edge`);
    }
    // The interpreter resumes past loopEnd via a SINGLE next edge; a fan-out (≥2 out-edges) would
    // silently drop all but the first. Restrict to ≤1 exit (an optional condition on it is fine —
    // it's evaluated by the normal traversal after the loop).
    if (outFrom(loopEndId).length > 1) {
      return err(
        `loopEnd '${loopEndId}' must have at most one outgoing edge (fan-out after a loop is not supported in v1)`,
      );
    }
    claimedLoopEnds.add(loopEndId);

    // The collected node must be a per-item node (a region node, or the splitOut itself for an
    // empty region) — collecting a value from outside the region would not be per-iteration.
    const loopEnd = nodeById.get(loopEndId);
    const collectFrom = String(
      (loopEnd?.config as { from?: unknown } | undefined)?.from ?? "",
    );
    const inRegion =
      collectFrom === n.id || regionNodeIds.includes(collectFrom);
    if (!inRegion) {
      return err(
        `loopEnd '${loopEndId}' collects '${collectFrom || "(unset)"}', which is not in its splitOut region`,
      );
    }

    regions.push({ splitOutId: n.id, loopEndId, regionNodeIds, collectFrom });
  }

  // A loopEnd with no owning splitOut is a stray region marker.
  for (const n of graph.nodes) {
    if (n.type === "loopEnd" && !claimedLoopEnds.has(n.id)) {
      return err(`loopEnd '${n.id}' has no matching splitOut`);
    }
  }

  return { regions, error: null };
}
