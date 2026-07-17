// react-flow model for the workflow canvas: node/edge types, seed graph, converters (extracted from CanvasPage).
import {
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Position,
} from "@xyflow/react";
import type { NodeType } from "@naary/dsl";
import {
  ACCENT,
  type CanvasEdge,
  type CanvasNode,
  type EdgeConditionDraft,
  nodeDisplayLabel,
  nodeSubtitle,
} from "../../lib/graph-model";

export const DEFAULT_KEY = "canvas";

/** Stable workflowKey derived from a display name (for newly-created workflows). */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || DEFAULT_KEY
  );
}

export function toFlowNodes(cs: CanvasNode[]): Node<NaaryData>[] {
  return cs.map((c) => ({
    id: c.id,
    type: "naary",
    position: c.position,
    data: { kind: c.type, config: c.config },
  }));
}
export function toFlowEdges(cs: CanvasEdge[]): FlowEdge[] {
  return cs.map((c) => ({
    id: c.id,
    source: c.source,
    target: c.target,
    data: { condition: c.condition },
    label: summarize(c.condition),
  }));
}

export interface NaaryData extends Record<string, unknown> {
  kind: NodeType;
  config?: Record<string, unknown>;
  /** Injected for rendering: this node has a pinned authoring sample (📌 badge). */
  pinned?: boolean;
  /** Injected for rendering: this node has lint issues (⚠ badge); text is the tooltip. */
  warning?: string;
}

/** A node on the canvas: accent bar, label, and connection handles. Entry nodes
 *  have no inbound handle; `end` has no outbound. */
function NaaryNode({ data, selected }: NodeProps<Node<NaaryData>>) {
  const kind = data.kind;
  const accent = ACCENT[kind];
  // Keep in sync with compile-graph's ENTRY_TYPES — every entry node has no inbound handle.
  const isEntry =
    kind === "start" ||
    kind === "webhookTrigger" ||
    kind === "scheduleTrigger" ||
    kind === "pollTrigger" ||
    kind === "errorTrigger" ||
    kind === "formTrigger" ||
    kind === "chatTrigger";
  const subtitle = nodeSubtitle(kind, data.config);
  // Provider-aware: an integration node reads "GitHub"/"Jira"/…, not the shared type
  // label "integration" (which collapses to the last-registered tile). See nodeDisplayLabel.
  const title = nodeDisplayLabel(kind, data.config);
  return (
    <div
      style={{
        minWidth: 132,
        borderRadius: "var(--radius-md)",
        border: data.warning
          ? "1px solid var(--state-paused)"
          : `1px solid ${accent}`,
        outline: selected
          ? `2px solid ${data.warning ? "var(--state-paused)" : accent}`
          : "none",
        background: "var(--card)",
        color: "var(--ink)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-body)",
        overflow: "hidden",
        boxShadow: "var(--shadow-node)",
      }}
    >
      {!isEntry && <Handle type="target" position={Position.Left} />}
      <div style={{ height: 4, background: accent }} />
      <div
        style={{
          padding: subtitle ? "9px 12px 4px" : "9px 12px",
          fontWeight: "var(--weight-semibold)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
        }}
      >
        <span>{title}</span>
        <span style={{ display: "flex", gap: 4 }}>
          {data.warning && (
            <span title={data.warning} style={{ fontSize: "var(--text-xs)" }}>
              ⚠️
            </span>
          )}
          {data.pinned && (
            <span
              title="Has a pinned sample output"
              style={{ fontSize: "var(--text-xs)" }}
            >
              📌
            </span>
          )}
        </span>
      </div>
      {subtitle && (
        <div
          className="mono"
          style={{
            padding: "0 12px 9px",
            fontSize: "var(--text-2xs)",
            color: "var(--ink-3)",
            maxWidth: 180,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {subtitle}
        </div>
      )}
      {kind !== "end" && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

export const nodeTypes = { naary: NaaryNode };

interface EdgeData extends Record<string, unknown> {
  condition?: EdgeConditionDraft;
}
export type FlowEdge = Edge<EdgeData>;

/** Short label for a conditional edge (shown on the canvas). */
export function summarize(c?: EdgeConditionDraft): string | undefined {
  if (!c || !c.path.trim()) return undefined;
  if (c.op === "exists") return `${c.path} exists`;
  return `${c.path} ${c.op} ${c.value}`;
}

export const SEED_NODES: Node<NaaryData>[] = [
  {
    id: "start",
    type: "naary",
    position: { x: 40, y: 140 },
    data: { kind: "start" },
  },
  {
    id: "approval",
    type: "naary",
    position: { x: 300, y: 140 },
    data: { kind: "humanApproval" },
  },
  {
    id: "end",
    type: "naary",
    position: { x: 560, y: 140 },
    data: { kind: "end" },
  },
];
export const SEED_EDGES: FlowEdge[] = [
  { id: "e1", source: "start", target: "approval" },
  { id: "e2", source: "approval", target: "end" },
];
