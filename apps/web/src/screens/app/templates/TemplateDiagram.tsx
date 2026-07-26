import "@xyflow/react/dist/style.css";
import {
  Background,
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import { useMemo } from "react";
import { HANDOFF_TARGET_FIELD } from "@naary/dsl";
import type { GraphDef, NodeType } from "@naary/dsl";
import { Icon } from "../../../components";
import { decompileGraph } from "../../../lib/decompile-graph";
import {
  ACCENT,
  nodeDisplayLabel,
  nodeSubtitle,
} from "../../../lib/graph-model";
import { iconForNode } from "./model";

/**
 * The template's REAL graph, rendered read-only in the preview (#574: "template detail view
 * renders the graph read-only"). Same auto-layout the canvas and the run view use
 * (`decompileGraph`), so what the preview shows is what the canvas will show after install.
 *
 * NOT `RunDiagram`. That component colors every node by RUN state, and a template has no
 * run — passing it an empty `ctx` renders every node in the dimmed "idle" style (50%
 * opacity, grey borders), which reads as a disabled or failed graph. Here every node is
 * drawn at full strength in its node-type accent, because that is the honest thing for a
 * graph that hasn't run: structure, not status.
 *
 * Lazily imported by PreviewModal on purpose — this module pulls in the @xyflow/react
 * chunk, which the Templates screen otherwise avoids (see the slugifyName note in model.ts).
 */

interface TemplateNodeData extends Record<string, unknown> {
  kind: NodeType;
  label: string;
  subtitle?: string;
}

const ENTRY_KINDS: ReadonlySet<NodeType> = new Set([
  "start",
  "webhookTrigger",
  "errorTrigger",
  "pollTrigger",
  "scheduleTrigger",
  "formTrigger",
  "chatTrigger",
  "mcpServerTrigger",
]);

function TemplateNode({ data }: NodeProps<Node<TemplateNodeData>>) {
  const accent = ACCENT[data.kind];
  return (
    <div
      style={{
        minWidth: 132,
        maxWidth: 200,
        borderRadius: "var(--radius-md)",
        border: `1.5px solid var(--line-mid)`,
        background: "var(--card)",
        color: "var(--ink)",
        fontSize: "var(--text-body)",
        overflow: "hidden",
        boxShadow: "0 1px 2px rgba(0,0,0,.18)",
      }}
    >
      {!ENTRY_KINDS.has(data.kind) && (
        <Handle type="target" position={Position.Left} />
      )}
      {/* The node-type accent is the only color here — there is no run state to report. */}
      <div style={{ height: 4, background: accent }} />
      <div
        style={{
          padding: "9px 11px",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Icon
          name={iconForNode(data.kind)}
          size={15}
          style={{ color: accent, flex: "none" }}
        />
        <span
          style={{
            fontWeight: "var(--weight-semibold)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {data.label}
        </span>
      </div>
      {data.subtitle && (
        <div
          className="mono"
          style={{
            padding: "0 11px 8px",
            fontSize: 10,
            color: "var(--ink-faint)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {data.subtitle}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { template: TemplateNode };
/**
 * `maxZoom: 1` stops a two-node template from being blown up to fill the box; the padding
 * is small because the modal is narrow and every pixel of width is legibility.
 */
const FIT_VIEW_OPTIONS = { padding: 0.08, maxZoom: 1 } as const;

/**
 * `decompileGraph` spaces columns for the CANVAS's node cards (300×132). These preview
 * cards are roughly half that, so reusing the canvas spacing verbatim makes a 6-node chain
 * ~1800px wide — which fitView then shrinks to ~0.4 zoom inside a modal, i.e. unreadable
 * 6px labels. Scaling the layout down (not the nodes) keeps the same shape at a zoom level
 * where the labels are actually legible.
 */
const COL_SCALE = 0.62;
const ROW_SCALE = 0.78;

export function TemplateDiagram({
  graph,
  height = 300,
}: {
  graph: GraphDef;
  height?: number;
}) {
  const { nodes, edges } = useMemo(() => {
    const layout = decompileGraph(graph);
    const flowNodes: Node<TemplateNodeData>[] = layout.nodes.map((n) => ({
      id: n.id,
      type: "template",
      position: {
        x: n.position.x * COL_SCALE,
        y: n.position.y * ROW_SCALE,
      },
      data: {
        kind: n.type,
        label: nodeDisplayLabel(n.type, n.config),
        subtitle: nodeSubtitle(n.type, n.config),
      },
    }));
    // A conditional edge is LABELLED with its real condition, so a branching template
    // (severity routing, a supervisor handoff) reads as branching rather than as an
    // unexplained fan-out. The label is the graph's own data, never invented.
    const flowEdges: Edge[] = graph.edges.map((e, i) => ({
      id: `t-${i}`,
      source: e.from,
      target: e.to,
      ...(e.condition
        ? {
            label: conditionLabel(e.condition),
            labelStyle: { fontSize: 10, fill: "var(--ink-3)" },
            labelBgStyle: { fill: "var(--panel)" },
          }
        : {}),
      style: { stroke: "var(--line-2)", strokeWidth: 1.5 },
    }));
    return { nodes: flowNodes, edges: flowEdges };
  }, [graph]);

  return (
    <div style={{ height, width: "100%" }} aria-label="Template graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnScroll={false}
        zoomOnScroll={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={18} size={1} />
      </ReactFlow>
    </div>
  );
}

/** A short human label for an edge condition — e.g. `severity = high`, `flagged exists`. */
function conditionLabel(
  c: NonNullable<GraphDef["edges"][number]["condition"]>,
) {
  const leaf = c.path.split(".").filter(Boolean).pop() ?? c.path;
  const value =
    c.value === undefined
      ? ""
      : typeof c.value === "string"
        ? ` ${c.value}`
        : ` ${JSON.stringify(c.value)}`;
  // A handoff edge's leaf is always `target` and its op always `eq`, so "target = billing"
  // spends its width on the part that never varies — and in the tight gap between adjacent
  // columns that surplus is what pushes the label under the next node. Show just the name.
  if (leaf === HANDOFF_TARGET_FIELD && c.op === "eq") return value.trim();
  const op = c.op === "eq" ? "=" : c.op === "neq" ? "≠" : c.op;
  return `${leaf} ${op}${value}`.trim();
}
