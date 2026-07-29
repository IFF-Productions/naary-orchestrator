import { canonicalize } from "./canonical";
import type { EdgeDef, GraphDef, NodeDef } from "./types";

/**
 * Structural diff of two graph versions (workflow diff — review what changed before promoting).
 * Pure + deterministic: nodes matched by id, edges matched by (from → to). A node is "changed"
 * when it exists in both but any of its type/config/onError/retry differ (canonical compare), and
 * the changed top-level fields are reported. Order-independent (uses id/pair keys, not positions).
 */

export interface NodeChange {
  id: string;
  before: NodeDef;
  after: NodeDef;
  /** Which top-level NodeDef fields differ: any of "type" | "config" | "onError" | "retry". */
  fields: string[];
}

export interface GraphDiff {
  nodesAdded: NodeDef[];
  nodesRemoved: NodeDef[];
  nodesChanged: NodeChange[];
  edgesAdded: EdgeDef[];
  edgesRemoved: EdgeDef[];
  /**
   * True when the edge SET is unchanged but its ORDER differs. Edge order is semantically
   * significant here — the interpreter takes the FIRST matching outgoing edge (walk.ts precedence)
   * and canonicalize()/contentHash preserve it — so a pure reorder is a real, behaviour-affecting
   * change, not a no-op.
   */
  edgesReordered: boolean;
  startNodeChanged: boolean;
}

// `name` is DISPLAY-only (nothing executes off it), but it is still part of the saved node: a
// diff that reports "no changes" after a node was retitled describes a version that isn't the
// one on screen, and the canvas's unsaved-changes guard (which asks graphsEqual whether there
// is work to lose) would let a rename be discarded silently.
const NODE_FIELDS = ["type", "name", "config", "onError", "retry"] as const;

/** Stable identity for an edge: source→target plus its (order-independent) condition. */
function edgeKey(e: EdgeDef): string {
  return `${e.from}\0${e.to}\0${e.condition ? canonicalize(e.condition) : ""}`;
}

function changedFields(a: NodeDef, b: NodeDef): string[] {
  return NODE_FIELDS.filter(
    (f) => canonicalize(a[f] ?? null) !== canonicalize(b[f] ?? null),
  );
}

export function diffGraphs(from: GraphDef, to: GraphDef): GraphDiff {
  const fromNodes = new Map(from.nodes.map((n) => [n.id, n]));
  const toNodes = new Map(to.nodes.map((n) => [n.id, n]));

  const nodesAdded: NodeDef[] = [];
  const nodesRemoved: NodeDef[] = [];
  const nodesChanged: NodeChange[] = [];

  for (const [id, after] of toNodes) {
    const before = fromNodes.get(id);
    if (!before) {
      nodesAdded.push(after);
      continue;
    }
    const fields = changedFields(before, after);
    if (fields.length > 0) nodesChanged.push({ id, before, after, fields });
  }
  for (const [id, before] of fromNodes) {
    if (!toNodes.has(id)) nodesRemoved.push(before);
  }

  const fromEdges = new Map(from.edges.map((e) => [edgeKey(e), e]));
  const toEdges = new Map(to.edges.map((e) => [edgeKey(e), e]));
  const edgesAdded: EdgeDef[] = [];
  const edgesRemoved: EdgeDef[] = [];
  for (const [k, e] of toEdges) if (!fromEdges.has(k)) edgesAdded.push(e);
  for (const [k, e] of fromEdges) if (!toEdges.has(k)) edgesRemoved.push(e);

  // Order matters (traversal precedence). When the SET is identical, a different sequence of edge
  // keys is a genuine reorder — flag it so an "edges only reshuffled" change isn't reported as none.
  const edgesReordered =
    edgesAdded.length === 0 &&
    edgesRemoved.length === 0 &&
    from.edges.map(edgeKey).join("\n") !== to.edges.map(edgeKey).join("\n");

  return {
    nodesAdded,
    nodesRemoved,
    nodesChanged,
    edgesAdded,
    edgesRemoved,
    edgesReordered,
    startNodeChanged: from.startNodeId !== to.startNodeId,
  };
}

/** True when the two graphs are structurally identical (no changes). */
export function graphsEqual(from: GraphDef, to: GraphDef): boolean {
  const d = diffGraphs(from, to);
  return (
    !d.startNodeChanged &&
    d.nodesAdded.length === 0 &&
    d.nodesRemoved.length === 0 &&
    d.nodesChanged.length === 0 &&
    d.edgesAdded.length === 0 &&
    d.edgesRemoved.length === 0 &&
    !d.edgesReordered
  );
}
