import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import type { GraphDef } from "@naary/dsl";
import type { ExecutionState, RunEvent } from "../../lib/api";
import { RunDetail } from "./RunDetail";

const ID = "wh-t1-9a8b7c";

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
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "start", to: "classify" },
    { from: "classify", to: "approve" },
    { from: "approve", to: "refund" },
    { from: "refund", to: "end" },
  ],
};

const graphResp = {
  graph: GRAPH,
  version: 3,
  workflowKey: "refund-triage",
};

const history: RunEvent[] = [
  { id: 1, kind: "started", label: "Run started", at: "2026-07-16T09:20:00Z" },
  {
    id: 2,
    kind: "activity",
    label: "Activity: runAgent",
    at: "2026-07-16T09:20:03Z",
  },
  {
    id: 3,
    kind: "activity",
    label: "Activity completed",
    at: "2026-07-16T09:20:05Z",
  },
];

// Shared handlers; per-story `state` overrides /executions/:id (status + ctx).
function handlers(state: ExecutionState, hist = history) {
  return [
    http.get("*/api/executions/:id/graph", () => HttpResponse.json(graphResp)),
    http.get("*/api/executions/:id/history", () => HttpResponse.json(hist)),
    http.get(
      "*/api/executions/:id/resume-url",
      () => new HttpResponse(null, { status: 404 }),
    ),
    http.get("*/api/executions/:id", () => HttpResponse.json(state)),
  ];
}

const meta: Meta<typeof RunDetail> = {
  title: "Screens/RunDetail",
  component: RunDetail,
  parameters: {
    layout: "fullscreen",
    router: { path: "/app/runs/:id", initialEntries: [`/app/runs/${ID}`] },
  },
  decorators: [
    (Story) => (
      <div style={{ background: "var(--bg)", minHeight: "100vh" }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof RunDetail>;

/** A completed run — the executed path is fully green on the canvas + the outputs render. */
export const Completed: Story = {
  parameters: {
    msw: {
      handlers: handlers({
        status: "completed",
        currentNodeId: "end",
        ctx: {
          __input: { orderId: "ord_42", amount: 640 },
          classify: { category: "billing_dispute", confidence: 0.94 },
          approve: { approved: true },
          refund: { refunded: true, id: "re_123" },
          end: {},
          __costUsd: 0.0142,
        },
      }),
    },
  },
};

/** Paused on the approval node — the Approve / Reject actions show. */
export const AwaitingApproval: Story = {
  parameters: {
    msw: {
      handlers: handlers(
        {
          status: "awaiting_approval",
          currentNodeId: "approve",
          ctx: {
            __input: { orderId: "ord_42", amount: 640 },
            classify: { category: "billing_dispute", confidence: 0.94 },
          },
        },
        history.slice(0, 2),
      ),
    },
  },
};
