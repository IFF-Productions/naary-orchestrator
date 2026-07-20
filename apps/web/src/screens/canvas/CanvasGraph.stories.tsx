import "@xyflow/react/dist/style.css";
import "../canvas.css";
import { Background, ReactFlow } from "@xyflow/react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Node } from "@xyflow/react";
import {
  type FlowEdge,
  type NaaryData,
  NodeActionsContext,
  nodeTypes,
} from "./flow";
import { edgeTypes } from "./NaaryEdge";

/**
 * Node cards + state-driven edges composed on a real react-flow canvas: the
 * ember dashed march into a running node, green done hops, a mono branch-label
 * chip on conditional edges, and the dimmed untaken branch.
 */
const NODES: Node<NaaryData>[] = [
  {
    id: "webhook",
    type: "naary",
    position: { x: 0, y: 0 },
    data: {
      kind: "webhookTrigger",
      pinned: true,
      runState: "done",
      runMs: 12,
    },
  },
  {
    id: "enrich",
    type: "naary",
    position: { x: 320, y: 0 },
    data: {
      kind: "httpRequest",
      config: { method: "GET", url: "https://api.example.com/company" },
      runState: "done",
      runMs: 842,
    },
  },
  {
    id: "summarize",
    type: "naary",
    position: { x: 640, y: 0 },
    data: {
      kind: "agent",
      config: { model: "claude-opus-4-8" },
      runState: "running",
    },
  },
  {
    id: "route",
    type: "naary",
    position: { x: 320, y: 160 },
    data: {
      kind: "switch",
      config: { rules: [] },
    },
  },
  {
    id: "approval",
    type: "naary",
    position: { x: 640, y: 160 },
    data: { kind: "humanApproval", runState: "waiting" },
  },
  {
    id: "log",
    type: "naary",
    position: { x: 640, y: 300 },
    data: { kind: "noOp", runState: "skipped" },
  },
];

const EDGES: FlowEdge[] = [
  {
    id: "e1",
    source: "webhook",
    target: "enrich",
    type: "naary",
    data: { runState: "done" },
  },
  {
    id: "e2",
    source: "enrich",
    target: "summarize",
    type: "naary",
    data: { runState: "active" },
  },
  {
    id: "e3",
    source: "enrich",
    target: "route",
    type: "naary",
    data: { runState: "idle" },
  },
  {
    id: "e4",
    source: "route",
    target: "approval",
    type: "naary",
    label: "amount gte 25000",
    data: {
      runState: "idle",
      condition: { path: "amount", op: "gte", value: "25000" },
    },
  },
  {
    id: "e5",
    source: "route",
    target: "log",
    type: "naary",
    label: "else",
    data: { runState: "skipped" },
  },
];

const meta: Meta = {
  title: "Canvas/Graph",
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj;

export const AuthoringLoop: Story = {
  render: () => (
    <div
      style={{
        height: 620,
        background:
          "radial-gradient(120% 90% at 20% 0%, var(--grad-a), var(--bg) 60%)",
      }}
    >
      <NodeActionsContext.Provider
        value={{ runNode: () => {}, deleteNode: () => {} }}
      >
        <ReactFlow
          nodes={NODES}
          edges={EDGES}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={26} size={1.1} />
        </ReactFlow>
      </NodeActionsContext.Provider>
    </div>
  ),
};
