import type { GraphDef, NodeDef } from "./types";

/**
 * Deterministic linear traversal: start at `graph.startNodeId` and follow the
 * single outgoing edge from each node until none remains.
 *
 * MUST stay deterministic — no time, randomness, or I/O. This runs inside the
 * Temporal workflow and is replay-sensitive. (CLAUDE.md Tier 1, rule 2.)
 *
 * Slice #1 assumption: linear graph, each node has at most one outgoing edge.
 * Generalising to branch/parallel/loop is a later slice.
 */
export function walk(graph: GraphDef): NodeDef[] {
  const nodeById = new Map<string, NodeDef>();
  for (const node of graph.nodes) {
    nodeById.set(node.id, node);
  }

  // First outgoing edge per node, in declared edge order (deterministic).
  const nextByFrom = new Map<string, string>();
  for (const edge of graph.edges) {
    if (!nextByFrom.has(edge.from)) {
      nextByFrom.set(edge.from, edge.to);
    }
  }

  const order: NodeDef[] = [];
  const visited = new Set<string>();
  let currentId: string | undefined = graph.startNodeId;

  while (currentId !== undefined) {
    if (visited.has(currentId)) {
      throw new Error(`walk: cycle detected at node '${currentId}'`);
    }
    const node = nodeById.get(currentId);
    if (node === undefined) {
      throw new Error(`walk: traversal reached unknown node '${currentId}'`);
    }
    visited.add(currentId);
    order.push(node);
    currentId = nextByFrom.get(currentId);
  }

  return order;
}
