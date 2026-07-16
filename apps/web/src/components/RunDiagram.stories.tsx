import type { Meta, StoryObj } from "@storybook/react-vite";
import type { GraphDef } from "@naary/dsl";
import { RunDiagram } from "./RunDiagram";

const meta: Meta<typeof RunDiagram> = {
  title: "Canvas/RunDiagram",
  component: RunDiagram,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof RunDiagram>;

// A realistic refund-triage flow: trigger → classify → human approval → refund → notify → end.
const GRAPH: GraphDef = {
  startNodeId: "start",
  nodes: [
    { id: "start", type: "webhookTrigger" },
    { id: "classify", type: "agent", config: { model: "claude-sonnet-5" } },
    {
      id: "approve",
      type: "humanApproval",
      config: { title: "Refund > $500" },
    },
    { id: "refund", type: "mcpTool", config: { tool: "stripe.refund" } },
    { id: "notify", type: "mcpTool", config: { tool: "slack.post" } },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "start", to: "classify" },
    { from: "classify", to: "approve" },
    { from: "approve", to: "refund" },
    { from: "refund", to: "notify" },
    { from: "notify", to: "end" },
  ],
};

// A node id present as a key in ctx means that node produced output (it executed).
const OUT = { category: "billing_dispute", confidence: 0.94 };

function Frame({
  ctx,
  currentNodeId,
  status,
}: {
  ctx: Record<string, unknown>;
  currentNodeId: string;
  status: string;
}) {
  return (
    <div style={{ height: 360, background: "var(--bg)" }}>
      <RunDiagram
        graph={GRAPH}
        ctx={ctx}
        currentNodeId={currentNodeId}
        status={status}
        height={360}
      />
    </div>
  );
}

/** Mid-run: the agent is executing; only the trigger has produced output so far. */
export const Running: Story = {
  render: () => (
    <Frame
      ctx={{ start: { orderId: "ord_42" } }}
      currentNodeId="classify"
      status="running"
    />
  ),
};

/** Paused on the human-approval node (the durable wait). Node reads "paused" (amber). */
export const AwaitingApproval: Story = {
  render: () => (
    <Frame
      ctx={{ start: { orderId: "ord_42" }, classify: OUT }}
      currentNodeId="approve"
      status="awaiting_approval"
    />
  ),
};

/** Failed on the refund tool — the node it died on is marked as the error (red). */
export const Failed: Story = {
  render: () => (
    <Frame
      ctx={{
        start: { orderId: "ord_42" },
        classify: OUT,
        approve: { approved: true },
      }}
      currentNodeId="refund"
      status="failed"
    />
  ),
};

/** Completed — the whole executed path is green, nothing dimmed. */
export const Completed: Story = {
  render: () => (
    <Frame
      ctx={{
        start: { orderId: "ord_42" },
        classify: OUT,
        approve: { approved: true },
        refund: { refunded: true },
        notify: { sent: true },
        end: {},
      }}
      currentNodeId="end"
      status="completed"
    />
  ),
};
