/**
 * Compile the editor's canvas model into a platform GraphDef and validate it with
 * the SAME `validateGraph` the server runs (so the on-canvas status matches the API
 * 400). Pure — no React, unit-tested in test/compile-graph.spec.ts.
 *
 * Entry-node rule: GraphDef needs exactly one `startNodeId`, so the canvas must
 * have exactly one `start`/`webhookTrigger` node — enforced here with a clear
 * message (validateGraph only checks the id resolves, not entry-node count).
 */
import type { EdgeDef, GraphDef, NodeDef, NodeType } from "@naary/dsl";
// Namespace import: @naary/dsl ships CommonJS (its `export *` becomes __exportStar),
// which rollup can't statically tree-shake for a named value import — but the
// runtime namespace object carries `validateGraph`. (Types above are erased.)
import * as dsl from "@naary/dsl";
import type { CanvasEdge, CanvasNode } from "./graph-model";

export interface CompileResult {
  graph?: GraphDef;
  error?: string;
}

const ENTRY_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  "start",
  "webhookTrigger",
]);

export function compileGraph(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): CompileResult {
  if (nodes.length === 0) {
    return { error: "Empty canvas — add a Start node to begin." };
  }

  const entries = nodes.filter((n) => ENTRY_TYPES.has(n.type));
  if (entries.length === 0) {
    return { error: "No entry node — add a Start (or Webhook) node." };
  }
  if (entries.length > 1) {
    return {
      error: "Multiple entry nodes — keep exactly one Start/Webhook node.",
    };
  }

  const graphNodes: NodeDef[] = nodes.map((n) => ({
    id: n.id,
    type: n.type,
    ...(n.config && Object.keys(n.config).length > 0
      ? { config: n.config }
      : {}),
  }));
  const graphEdges: EdgeDef[] = edges.map((e) => ({
    from: e.source,
    to: e.target,
  }));

  const graph: GraphDef = {
    nodes: graphNodes,
    edges: graphEdges,
    startNodeId: entries[0].id,
  };

  const check = dsl.validateGraph(graph);
  if (!check.valid) return { error: check.error ?? "Invalid graph." };
  return { graph };
}
