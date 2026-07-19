/**
 * Executed-path graph pane for the redesigned Run Detail screen — a run-detail-
 * local fork of components/RunDiagram (which is shared with CanvasPage and stays
 * untouched). Recreates the design's left pane: the run's graph on the dotted-
 * grid ambient wash with the ACTUAL path highlighted — done nodes green-tinted
 * with solid green edges, the waiting node amber with a pulse ring + dashed
 * marching edge into it, pending nodes dimmed/dashed, skipped branches dimmed
 * dashed with branch-label chips — plus the sticky ran/waiting/pending/skipped
 * legend row at the bottom. States come from the REAL run state via
 * computeStepStates; nothing here invents data.
 */
import "@xyflow/react/dist/style.css";
import {
  Background,
  Controls,
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
} from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphDef, NodeType } from "@naary/dsl";
import { Icon, type IconName } from "../../../components";
import { decompileGraph } from "../../../lib/decompile-graph";
import {
  ACCENT,
  nodeDisplayLabel,
  nodeSubtitle,
} from "../../../lib/graph-model";
import {
  edgeConditionLabel,
  nodeIcon,
  STEP_FG,
  STEP_WORD,
  type StepState,
} from "./run-view-model";

const FIT_VIEW_OPTIONS = { padding: 0.2 } as const;

/* ---------------- Node card (design: 13px-radius state-tinted card) ---------------- */

interface RunGraphNodeData extends Record<string, unknown> {
  kind: NodeType;
  label: string;
  meta: string;
  icon: IconName;
  accent: string;
  state: StepState;
  selected: boolean;
}

function stateCardStyle(state: StepState, selected: boolean) {
  const solid = (color: string, soft: string, glow: string) => ({
    border: `1px solid color-mix(in srgb, ${color} 55%, transparent)`,
    background: `linear-gradient(120deg, ${soft}, var(--card))`,
    opacity: 1,
    boxShadow: glow,
    animation: undefined as string | undefined,
  });
  let s;
  switch (state) {
    case "done":
      s = solid(
        "var(--state-done)",
        "var(--done-soft)",
        "0 6px 22px -16px rgba(53, 196, 122, 0.55)",
      );
      break;
    case "waiting":
      s = {
        ...solid("var(--state-paused)", "var(--paused-soft)", "none"),
        border: "1px solid var(--state-paused)",
        animation: "rdPulseCard 1.4s ease-in-out infinite",
      };
      break;
    case "running":
      s = solid(
        "var(--brand)",
        "var(--brand-soft)",
        "0 0 0 1px rgba(242, 98, 46, 0.35), 0 12px 34px -14px rgba(242, 98, 46, 0.55)",
      );
      break;
    case "error":
      s = solid(
        "var(--state-error)",
        "var(--error-soft)",
        "var(--shadow-node)",
      );
      break;
    case "pending":
      s = {
        border: "1px dashed var(--line-2)",
        background: "var(--card)",
        opacity: 0.7,
        boxShadow: "none",
        animation: undefined,
      };
      break;
    default: // skipped
      s = {
        border: "1px dashed var(--line-2)",
        background: "var(--card)",
        opacity: 0.5,
        boxShadow: "none",
        animation: undefined,
      };
  }
  if (selected && state !== "waiting")
    s.boxShadow =
      "0 0 0 2px color-mix(in srgb, var(--brand) 55%, transparent), 0 12px 34px -16px rgba(242, 98, 46, 0.45)";
  return s;
}

function RunGraphNode({ data }: NodeProps<Node<RunGraphNodeData>>) {
  const s = stateCardStyle(data.state, data.selected);
  const isEntry =
    data.kind === "start" ||
    data.kind === "webhookTrigger" ||
    data.kind === "errorTrigger" ||
    data.kind === "pollTrigger" ||
    data.kind === "scheduleTrigger" ||
    data.kind === "formTrigger" ||
    data.kind === "chatTrigger";
  return (
    <div
      style={{
        position: "relative",
        width: 216,
        borderRadius: 13,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 13px",
        cursor: "pointer",
        transition: "box-shadow .25s, opacity .25s",
        ...s,
      }}
    >
      {!isEntry && <Handle type="target" position={Position.Top} />}
      <span
        style={{
          position: "relative",
          width: 32,
          height: 32,
          flex: "none",
          borderRadius: 8,
          border: `1px solid ${data.accent}`,
          color: data.accent,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {data.state === "waiting" && (
          <span
            style={{
              position: "absolute",
              inset: -1,
              borderRadius: 8,
              background: "var(--state-paused)",
              animation: "rdPing 1.5s ease-out infinite",
              pointerEvents: "none",
            }}
          />
        )}
        <Icon name={data.icon} size={15} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 12.5,
            fontWeight: "var(--weight-semibold)",
            color: "var(--ink)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {data.label}
        </span>
        <span
          className="mono"
          style={{
            display: "block",
            fontSize: 10,
            color: "var(--ink-3)",
            marginTop: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {data.meta}
        </span>
      </span>
      <span
        className="mono"
        style={{
          fontSize: 9,
          fontWeight: "var(--weight-bold)",
          letterSpacing: ".05em",
          textTransform: "uppercase",
          color: STEP_FG[data.state],
          flex: "none",
        }}
      >
        {STEP_WORD[data.state]}
      </span>
      {data.kind !== "end" && (
        <Handle type="source" position={Position.Bottom} />
      )}
    </div>
  );
}

const nodeTypes = { runStep: RunGraphNode };

/* ---------------- Edge styling per executed-path state ---------------- */

function edgeVisual(
  sourceState: StepState | undefined,
  targetState: StepState | undefined,
): { stroke: string; dash?: string; animated: boolean; opacity: number } {
  if (targetState === "done" && sourceState === "done")
    return { stroke: "var(--state-done)", animated: false, opacity: 1 };
  if (targetState === "waiting" && sourceState === "done")
    return {
      stroke: "var(--state-paused)",
      dash: "6 8",
      animated: true,
      opacity: 1,
    };
  if (targetState === "running" && sourceState === "done")
    return { stroke: "var(--brand)", dash: "6 8", animated: true, opacity: 1 };
  if (targetState === "error")
    return { stroke: "var(--state-error)", animated: false, opacity: 1 };
  if (targetState === "pending")
    return {
      stroke: "var(--line-2)",
      dash: "5 7",
      animated: false,
      opacity: 0.8,
    };
  // Skipped branch (not taken).
  return {
    stroke: "var(--line-2)",
    dash: "3 7",
    animated: false,
    opacity: 0.55,
  };
}

export interface RunGraphProps {
  graph: GraphDef;
  states: Record<string, StepState>;
  /** Extra mono meta on the waiting node, e.g. "waiting · 2d 4h" (real age). */
  waitingAge?: string | null;
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
  height?: number;
}

export function RunGraph({
  graph,
  states,
  waitingAge,
  selectedId,
  onSelect,
  height = 430,
}: RunGraphProps) {
  // Layout is a pure function of the (immutable-for-a-run) graph snapshot.
  const layout = useMemo(() => decompileGraph(graph), [graph]);

  const { nodes, edges } = useMemo(() => {
    // decompileGraph lays out left→right (columns = BFS depth, rows = fan-out);
    // transpose to TOP→DOWN — the design's narrow pane reads vertically, and the
    // 216px cards would overlap on the editor's 220px columns.
    const transpose = (p: { x: number; y: number }) => ({
      x: 24 + Math.round((p.y - 40) / 120) * 252,
      y: 24 + Math.round((p.x - 40) / 220) * 98,
    });
    const flowNodes: Node<RunGraphNodeData>[] = layout.nodes.map((n) => {
      const state = states[n.id] ?? "pending";
      const meta =
        state === "waiting" && waitingAge
          ? `waiting · ${waitingAge}`
          : state === "skipped"
            ? "not taken"
            : (nodeSubtitle(n.type, n.config) ?? n.type);
      return {
        id: n.id,
        type: "runStep",
        position: transpose(n.position),
        data: {
          kind: n.type,
          label: nodeDisplayLabel(n.type, n.config),
          meta,
          icon: nodeIcon(n.type),
          accent: ACCENT[n.type],
          state,
          selected: selectedId === n.id,
        },
      };
    });

    const flowEdges: Edge[] = layout.edges.map((e) => {
      const sourceState = states[e.source];
      const targetState = states[e.target];
      const v = edgeVisual(sourceState, targetState);
      // Branch-label chip: the edge's own condition, or "else" on the
      // unconditional sibling of a conditional fan-out (if/switch fallback).
      const graphEdge = graph.edges.find(
        (ge) => ge.from === e.source && ge.to === e.target,
      );
      const siblingsConditional = graph.edges.some(
        (ge) => ge.from === e.source && ge.to !== e.target && ge.condition,
      );
      const label = graphEdge?.condition
        ? edgeConditionLabel(graphEdge.condition)
        : siblingsConditional
          ? "else"
          : undefined;
      const taken =
        targetState === "done" ||
        targetState === "waiting" ||
        targetState === "running";
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        animated: v.animated,
        style: {
          stroke: v.stroke,
          strokeWidth: 2.2,
          opacity: v.opacity,
          ...(v.dash && !v.animated ? { strokeDasharray: v.dash } : {}),
        },
        ...(label
          ? {
              label,
              labelStyle: {
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                fill: taken ? "var(--state-done)" : "var(--ink-3)",
              },
              labelBgStyle: { fill: "var(--surface)", fillOpacity: 0.95 },
              labelBgPadding: [7, 3] as [number, number],
              labelBgBorderRadius: 6,
            }
          : {}),
      };
    });
    return { nodes: flowNodes, edges: flowEdges };
  }, [layout, graph, states, selectedId, waitingAge]);

  // Full-screen overlay + refit-on-resize — same behaviour as the shared diagram.
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const rfRef = useRef<{
    fitView: (o?: typeof FIT_VIEW_OPTIONS) => void;
  } | null>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() =>
        rfRef.current?.fitView(FIT_VIEW_OPTIONS),
      );
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const legend: { color: string; dashed?: boolean; label: string }[] = [
    { color: "var(--state-done)", label: "ran" },
    { color: "var(--state-paused)", label: "waiting" },
    { color: "var(--ink-3)", label: "pending" },
    { color: "var(--ink-3)", dashed: true, label: "skipped" },
  ];

  return (
    <div
      style={
        fullscreen
          ? {
              position: "fixed",
              inset: 0,
              zIndex: 1000,
              display: "flex",
              flexDirection: "column",
              background: "var(--bg)",
            }
          : {
              display: "flex",
              flexDirection: "column",
              border: "1px solid var(--line-mid)",
              borderRadius: "var(--radius-xl)",
              overflow: "hidden",
              background:
                "radial-gradient(120% 90% at 20% 0%, var(--grad-a), var(--bg) 60%)",
            }
      }
    >
      <div style={{ padding: "16px 20px 6px", flex: "none" }}>
        <div
          className="mono"
          style={{
            fontSize: "var(--text-xs)",
            letterSpacing: ".1em",
            textTransform: "uppercase",
            color: "var(--ink-faint)",
          }}
        >
          Executed path
        </div>
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--ink-faint)",
            marginTop: 5,
            lineHeight: "var(--leading-snug)",
          }}
        >
          The route this run actually took — dimmed dashed steps were not taken
          or haven't run yet.
        </div>
      </div>
      <div
        ref={wrapRef}
        style={{
          height: fullscreen ? "auto" : height,
          flex: fullscreen ? 1 : "none",
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={FIT_VIEW_OPTIONS}
          onInit={(inst) => {
            rfRef.current = inst;
          }}
          onNodeClick={(_, n) => onSelect(n.id)}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnScroll={fullscreen}
          panOnScroll={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={26} size={1.1} color="var(--grid)" />
          <Controls showInteractive={false} />
          <Panel position="top-right">
            <button
              type="button"
              className="rf-fs-btn"
              onClick={() => setFullscreen((v) => !v)}
              aria-label={fullscreen ? "Exit full screen" : "Full screen"}
              title={fullscreen ? "Exit full screen (Esc)" : "Full screen"}
            >
              <Icon name={fullscreen ? "x" : "expand"} size={15} />
            </button>
          </Panel>
        </ReactFlow>
      </div>
      {/* Sticky legend row (the pane has a fixed height, so it's always visible). */}
      <div
        style={{
          flex: "none",
          display: "flex",
          gap: 14,
          flexWrap: "wrap",
          padding: "10px 20px",
          borderTop: "1px solid var(--line)",
          background: "color-mix(in srgb, var(--panel) 82%, transparent)",
          backdropFilter: "blur(6px)",
          fontSize: "var(--text-xs)",
          color: "var(--ink-faint)",
        }}
      >
        {legend.map((l) => (
          <span
            key={l.label}
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: 3,
                background: l.dashed ? "transparent" : l.color,
                border: l.dashed ? `1px dashed ${l.color}` : "none",
                opacity: l.label === "pending" ? 0.7 : 1,
              }}
            />
            {l.label}
          </span>
        ))}
      </div>
    </div>
  );
}
