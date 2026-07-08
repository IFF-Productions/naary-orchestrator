import type { GraphDef } from "@naary/dsl";

type NodeDef = GraphDef["nodes"][number];

/**
 * Nodes in execution-ish order for the Simple-mode step list: a depth-first walk from
 * `startNodeId` following edges (declared order), then any unreachable nodes appended. Pure.
 * For a linear automation this is the natural top-to-bottom order; branches interleave but every
 * node appears exactly once.
 */
export function orderedNodes(graph: GraphDef): NodeDef[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const out: NodeDef[] = [];
  const visit = (id: string): void => {
    const node = byId.get(id);
    if (!node || seen.has(id)) return;
    seen.add(id);
    out.push(node);
    for (const e of graph.edges.filter((e) => e.from === id)) visit(e.to);
  };
  visit(graph.startNodeId);
  for (const n of graph.nodes) if (!seen.has(n.id)) out.push(n);
  return out;
}
