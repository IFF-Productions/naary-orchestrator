/**
 * Inverse of compile-graph: turn a stored GraphDef back into the editor model so a
 * saved workflow can be opened on the canvas. Positions aren't persisted (they're
 * editor-only), so we auto-layout left→right by BFS depth from the start node.
 * Pure — unit-tested in test/decompile-graph.spec.ts.
 */
import type { EdgeCondition, GraphDef } from "@naary/dsl";
import type { CanvasEdge, CanvasNode, EdgeConditionDraft } from "./graph-model";

// Spacing sized for the redesigned node cards (min 176 / max 244 px wide, ~66 px
// tall with a meta line) so auto-laid-out columns can't overlap.
const COL = 300;
const ROW = 132;

export function decompileGraph(graph: GraphDef): {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
} {
  const depth = layoutDepths(graph);
  const rowByDepth = new Map<number, number>();

  const nodes: CanvasNode[] = graph.nodes.map((n) => {
    const d = depth.get(n.id) ?? 0;
    const row = rowByDepth.get(d) ?? 0;
    rowByDepth.set(d, row + 1);
    // `onError` + `retry` are first-class NodeDef fields; surface them back into config-space
    // so the canvas editor (which works in config) shows/edits them.
    const config =
      n.onError || n.retry || n.name || n.config
        ? {
            ...n.config,
            ...(n.onError ? { onError: n.onError } : {}),
            ...(n.retry ? { retry: n.retry } : {}),
            ...(n.name ? { __name: n.name } : {}),
          }
        : undefined;
    return {
      id: n.id,
      type: n.type,
      position: { x: 40 + d * COL, y: 40 + row * ROW },
      ...(config ? { config } : {}),
    };
  });

  const edges: CanvasEdge[] = graph.edges.map((e, i) => ({
    id: `e-${i}`,
    source: e.from,
    target: e.to,
    ...(e.condition ? { condition: draftFromCondition(e.condition) } : {}),
  }));

  return { nodes, edges };
}

/** BFS distance from startNodeId → column depth; unreachable nodes go to column 0. */
function layoutDepths(graph: GraphDef): Map<string, number> {
  const depth = new Map<string, number>([[graph.startNodeId, 0]]);
  const queue = [graph.startNodeId];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const d = depth.get(id) ?? 0;
    for (const e of graph.edges) {
      if (e.from === id && !depth.has(e.to)) {
        depth.set(e.to, d + 1);
        queue.push(e.to);
      }
    }
  }
  for (const n of graph.nodes) if (!depth.has(n.id)) depth.set(n.id, 0);
  return depth;
}

/** EdgeCondition → editor draft (value back to a raw string for the inputs). */
function draftFromCondition(c: EdgeCondition): EdgeConditionDraft {
  if (c.op === "exists") return { path: c.path, op: "exists", value: "" };
  if (c.op === "in") {
    return {
      path: c.path,
      op: "in",
      value: Array.isArray(c.value)
        ? c.value.join(", ")
        : String(c.value ?? ""),
    };
  }
  return {
    path: c.path,
    op: c.op,
    value: c.value === undefined ? "" : String(c.value),
  };
}
