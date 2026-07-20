// react-flow model for the workflow canvas: node/edge types, seed graph, converters (extracted from CanvasPage).
import {
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Position,
} from "@xyflow/react";
import { createContext, useContext } from "react";
import type { NodeType } from "@naary/dsl";
import {
  type CanvasEdge,
  type CanvasNode,
  type EdgeConditionDraft,
  nodeDisplayLabel,
  nodeSubtitle,
} from "../../lib/graph-model";
import type { EdgeRunState } from "./NaaryEdge";
import { NodeCard, type NodeRunState } from "./NodeCard";

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
  /** Injected for rendering: this node has a pinned authoring sample (badge). */
  pinned?: boolean;
  /** Injected for rendering: this node has lint issues (amber badge); text is the tooltip. */
  warning?: string;
  /** Injected for rendering: single-node test-run state (idle when absent). */
  runState?: NodeRunState;
  /** Injected for rendering: measured wall-clock (ms) of the last test run. */
  runMs?: number;
}

/** Keep in sync with compile-graph's ENTRY_TYPES — every entry node has no inbound handle. */
export function isEntryKind(kind: NodeType): boolean {
  return (
    kind === "start" ||
    kind === "webhookTrigger" ||
    kind === "scheduleTrigger" ||
    kind === "pollTrigger" ||
    kind === "errorTrigger" ||
    kind === "formTrigger" ||
    kind === "chatTrigger"
  );
}

/** Per-node actions the canvas provides to node renderers (stable via context so
 *  injecting callbacks into node `data` doesn't churn react-flow renders). */
export const NodeActionsContext = createContext<{
  /** Run a single-node test for this node (wired to the existing test machinery). */
  runNode?: (id: string) => void;
  /** Delete this node (wired to the canvas's existing node deletion). */
  deleteNode?: (id: string) => void;
}>({});

/** Cost-cap / per-call cost chip — ONLY from real DSL config fields (codeAgent's
 *  maxBudgetUsd hard stop; the metered flat costUsd on tool/action nodes). */
export function costChipFor(
  config: Record<string, unknown> | undefined,
): string | undefined {
  if (!config) return undefined;
  const cap = config.maxBudgetUsd;
  if (typeof cap === "number" && cap > 0) return `cap $${cap}`;
  const perCall = config.costUsd;
  if (typeof perCall === "number" && perCall > 0) return `$${perCall}/call`;
  return undefined;
}

/** A node on the canvas: the redesigned state-driven card + connection handles.
 *  Entry nodes have no inbound handle; `end` has no outbound. */
function NaaryNode({ id, data, selected }: NodeProps<Node<NaaryData>>) {
  const kind = data.kind;
  const { runNode, deleteNode } = useContext(NodeActionsContext);
  const subtitle = nodeSubtitle(kind, data.config);
  // Provider-aware: an integration node reads "GitHub"/"Jira"/…, not the shared type
  // label "integration" (which collapses to the last-registered tile). See nodeDisplayLabel.
  const title = nodeDisplayLabel(kind, data.config);
  const state = data.runState ?? "idle";
  // No ▶ on terminal/no-input nodes — nothing runnable to test.
  const onRun =
    runNode && kind !== "end" && state !== "no-input"
      ? () => runNode(id)
      : undefined;
  return (
    <>
      {!isEntryKind(kind) && <Handle type="target" position={Position.Left} />}
      <NodeCard
        kind={kind}
        title={title}
        subtitle={subtitle}
        state={state}
        selected={selected}
        pinned={data.pinned}
        warning={data.warning}
        runMs={data.runMs}
        costChip={costChipFor(data.config)}
        onRun={onRun}
        onDelete={deleteNode ? () => deleteNode(id) : undefined}
      />
      {kind !== "end" && <Handle type="source" position={Position.Right} />}
    </>
  );
}

export const nodeTypes = { naary: NaaryNode };

interface EdgeData extends Record<string, unknown> {
  condition?: EdgeConditionDraft;
  /** Injected for rendering: derived edge run-state (idle when absent). */
  runState?: EdgeRunState;
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
