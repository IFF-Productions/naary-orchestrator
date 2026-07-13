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
import type { GraphDef, NodeType } from "@naary/dsl";
import { decompileGraph } from "../lib/decompile-graph";
import { ACCENT, nodeDisplayLabel, nodeSubtitle } from "../lib/graph-model";
import { isFailure, isTerminal } from "../lib/run-status";

/**
 * Read-only canvas of the graph a run EXECUTED, with the executed path highlighted — the
 * run-mode canvas from the Naary design. A node that produced output (its id is a key in the
 * run ctx) is "done" (green); the node the run is currently on is "running" (ember) or "paused"
 * (amber); everything not reached is dimmed. Edges between two executed nodes are drawn solid;
 * the edge into the current node animates (the design's dashed "current" edge).
 */
type RunState = "running" | "paused" | "done" | "error" | "idle";

const RUN_COLOR: Record<RunState, string> = {
  running: "var(--state-running)",
  paused: "var(--state-paused)",
  done: "var(--state-done)",
  error: "var(--state-error)",
  idle: "var(--line-2)",
};

interface RunNodeData extends Record<string, unknown> {
  kind: NodeType;
  label: string;
  subtitle?: string;
  runState: RunState;
}

function RunNode({ data }: NodeProps<Node<RunNodeData>>) {
  const { runState } = data;
  const color = RUN_COLOR[runState];
  const live = runState === "running" || runState === "paused";
  const dim = runState === "idle";
  const isEntry =
    data.kind === "start" ||
    data.kind === "webhookTrigger" ||
    data.kind === "errorTrigger";
  return (
    <div
      style={{
        minWidth: 132,
        borderRadius: "var(--radius-md)",
        border: `1.5px solid ${color}`,
        background: "var(--card)",
        color: "var(--ink)",
        fontSize: "var(--text-body)",
        overflow: "hidden",
        opacity: dim ? 0.5 : 1,
        boxShadow: live
          ? `0 0 0 3px color-mix(in srgb, ${color} 22%, transparent)`
          : "0 1px 2px rgba(0,0,0,.18)",
      }}
    >
      {!isEntry && <Handle type="target" position={Position.Left} />}
      {/* Node-type accent on top; the run-state color owns the border. */}
      <div style={{ height: 4, background: ACCENT[data.kind] }} />
      <div
        style={{
          padding: "9px 12px",
          fontWeight: "var(--weight-semibold)",
          display: "flex",
          alignItems: "center",
          gap: 7,
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            flex: "none",
            background: color,
            animation: live ? "blink 1.4s ease-in-out infinite" : undefined,
          }}
        />
        {data.label}
      </div>
      {data.subtitle && (
        <div
          className="mono"
          style={{
            padding: "0 12px 9px",
            fontSize: "var(--text-2xs)",
            color: "var(--ink-3)",
          }}
        >
          {data.subtitle}
        </div>
      )}
      {data.kind !== "end" && (
        <Handle type="source" position={Position.Right} />
      )}
    </div>
  );
}

const nodeTypes = { run: RunNode };

/** Executed-path colouring: which run-state each node is in for this run. */
function nodeRunState(
  id: string,
  executed: Set<string>,
  currentNodeId: string,
  status: string,
): RunState {
  if (id === currentNodeId && !isTerminal(status)) {
    return status === "awaiting_approval" || status === "awaiting_webhook"
      ? "paused"
      : "running";
  }
  // A failed run marks the node it died on (if known) as the error.
  if (id === currentNodeId && isFailure(status)) return "error";
  return executed.has(id) ? "done" : "idle";
}

export interface RunDiagramProps {
  graph: GraphDef;
  /** The run context — a node id present as a key means that node produced output (executed). */
  ctx: Record<string, unknown>;
  currentNodeId: string;
  status: string;
  height?: number;
}

export function RunDiagram({
  graph,
  ctx,
  currentNodeId,
  status,
  height = 340,
}: RunDiagramProps) {
  const { nodes, edges } = useMemo(() => {
    const { nodes: gn, edges: ge } = decompileGraph(graph);
    const ids = new Set(gn.map((n) => n.id));
    const executed = new Set(Object.keys(ctx).filter((k) => ids.has(k)));

    const flowNodes: Node<RunNodeData>[] = gn.map((n) => ({
      id: n.id,
      type: "run",
      position: n.position,
      data: {
        kind: n.type,
        label: nodeDisplayLabel(n.type, n.config),
        subtitle: nodeSubtitle(n.type, n.config),
        runState: nodeRunState(n.id, executed, currentNodeId, status),
      },
    }));

    const flowEdges: Edge[] = ge.map((e) => {
      const bothRun = executed.has(e.source) && executed.has(e.target);
      const intoCurrent =
        e.target === currentNodeId &&
        executed.has(e.source) &&
        !isTerminal(status);
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        animated: intoCurrent, // the design's dashed "current" edge
        style: {
          stroke: intoCurrent
            ? "var(--brand)"
            : bothRun
              ? "var(--state-done)"
              : "var(--line-2)",
          strokeWidth: bothRun || intoCurrent ? 2 : 1,
          opacity: bothRun || intoCurrent ? 1 : 0.5,
        },
      };
    });
    return { nodes: flowNodes, edges: flowEdges };
  }, [graph, ctx, currentNodeId, status]);

  return (
    <div style={{ height, width: "100%" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        panOnScroll={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={22} size={1} color="var(--line)" />
      </ReactFlow>
    </div>
  );
}
