import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import type { GraphDef } from "@naary/dsl";
import type { ExecutionState, RunEvent } from "../../lib/api";
import { RunDetail } from "./RunDetail";

const ID = "wh-t1-9a8b7c";

/** A deal-notifier-shaped graph with a real branch so the executed-path view
 *  shows a taken (high-value) branch and a skipped one with its label chip. */
const GRAPH: GraphDef = {
  startNodeId: "start",
  nodes: [
    { id: "start", type: "webhookTrigger" },
    {
      id: "enrich",
      type: "httpRequest",
      config: { method: "GET", url: "https://api.clearbit.com/company" },
    },
    { id: "classify", type: "agent", config: { model: "claude-sonnet-5" } },
    { id: "route", type: "if", config: {} },
    {
      id: "approve",
      type: "humanApproval",
      config: {
        title: "Refund > $500",
        instructions: "Review the drafted summary before the refund is issued.",
        timeoutHours: 72,
        // Slice 1 routing — drives the hero's real SLA/approver/escalation chips.
        slaHours: 48,
        approvers: {
          emails: ["sam@acme.io"],
          groupIds: ["finance-leads"],
        },
        remindAfterHours: [4, 12],
        escalateAfterHours: 20,
        escalateTo: "@ops-oncall",
      },
    },
    {
      id: "autolog",
      type: "set",
      config: { fields: { logged: true } },
    },
    { id: "refund", type: "mcpTool", config: { tool: "stripe.refund" } },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "start", to: "enrich" },
    { from: "enrich", to: "classify" },
    { from: "classify", to: "route" },
    {
      from: "route",
      to: "approve",
      condition: { path: "classify.amount", op: "gte", value: 500 },
    },
    { from: "route", to: "autolog" },
    { from: "approve", to: "refund" },
    { from: "refund", to: "end" },
  ],
};

const graphResp = {
  graph: GRAPH,
  version: 3,
  workflowKey: "refund-triage",
};

const CTX_UP_TO_ROUTE = {
  __input: { orderId: "ord_42", amount: 640 },
  enrich: { company: "Acme Corp", employees: 250 },
  classify: { category: "billing_dispute", amount: 640, confidence: 0.94 },
  route: { matched: true },
};

const pausedHistory: RunEvent[] = [
  { id: 1, kind: "started", label: "Run started", at: "2026-07-17T09:20:00Z" },
  {
    id: 2,
    kind: "activity",
    label: "Activity: callHttp",
    at: "2026-07-17T09:20:01Z",
  },
  {
    id: 3,
    kind: "activity",
    label: "Activity completed",
    at: "2026-07-17T09:20:02Z",
  },
  {
    id: 4,
    kind: "activity",
    label: "Activity: callAgent",
    at: "2026-07-17T09:20:03Z",
  },
  {
    id: 5,
    kind: "activity",
    label: "Activity completed",
    at: "2026-07-17T09:20:05Z",
  },
  {
    id: 6,
    kind: "timer",
    label: "Timer started (approval timeout)",
    at: "2026-07-17T09:20:06Z",
  },
];

const completedHistory: RunEvent[] = [
  ...pausedHistory,
  {
    id: 7,
    kind: "signal",
    label: "Signal: approval",
    at: "2026-07-18T11:41:00Z",
  },
  {
    id: 8,
    kind: "activity",
    label: "Activity: callMcpTool",
    at: "2026-07-18T11:41:01Z",
  },
  {
    id: 9,
    kind: "activity",
    label: "Activity completed",
    at: "2026-07-18T11:41:02Z",
  },
  {
    id: 10,
    kind: "completed",
    label: "Run completed",
    at: "2026-07-18T11:41:02Z",
  },
];

const rejectedHistory: RunEvent[] = [
  ...pausedHistory,
  {
    id: 7,
    kind: "signal",
    label: "Signal: approval",
    at: "2026-07-18T11:41:00Z",
  },
  {
    id: 8,
    kind: "completed",
    label: "Run completed",
    at: "2026-07-18T11:41:01Z",
  },
];

// Shared handlers; per-story `state` overrides /executions/:id (status + ctx).
function handlers(state: ExecutionState, hist: RunEvent[]) {
  return [
    http.get("*/api/executions/:id/graph", () => HttpResponse.json(graphResp)),
    http.get("*/api/executions/:id/history", () => HttpResponse.json(hist)),
    http.get(
      "*/api/executions/:id/resume-url",
      () => new HttpResponse(null, { status: 404 }),
    ),
    http.get("*/api/executions/:id", () => HttpResponse.json(state)),
    http.get("*/api/me/permissions", () =>
      HttpResponse.json({ restricted: false }),
    ),
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
      <div
        style={{
          background:
            "radial-gradient(120% 70% at 85% -5%, var(--grad-a), var(--bg) 55%)",
          minHeight: "100vh",
        }}
      >
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof RunDetail>;

/** The hero paused state: calm amber "Paused — waiting on approval" with the
 *  suspended-since age, the approval prompt, and decide-in-place actions. The
 *  graph shows the amber waiting node, the marching edge into it, and the
 *  skipped low-value branch with its "else" chip. */
export const AwaitingApproval: Story = {
  parameters: {
    msw: {
      handlers: handlers(
        {
          status: "awaiting_approval",
          currentNodeId: "approve",
          ctx: { ...CTX_UP_TO_ROUTE, __costUsd: 0.0021 },
        },
        pausedHistory,
      ),
    },
  },
};

/** A completed run — green hero, fully-green executed path, per-step outputs. */
export const Completed: Story = {
  parameters: {
    msw: {
      handlers: handlers(
        {
          status: "completed",
          currentNodeId: "end",
          ctx: {
            ...CTX_UP_TO_ROUTE,
            approve: { approved: true },
            refund: { refunded: true, id: "re_123" },
            end: {},
            __costUsd: 0.0142,
          },
        },
        completedHistory,
      ),
    },
  },
};

/** Rejected at the approval gate — red hero; downstream steps stay pending. */
export const Rejected: Story = {
  parameters: {
    msw: {
      handlers: handlers(
        {
          status: "rejected",
          currentNodeId: "approve",
          ctx: { ...CTX_UP_TO_ROUTE, __costUsd: 0.0021 },
        },
        rejectedHistory,
      ),
    },
  },
};

/** A live run mid-execution — ember spinner hero, ember current node. */
export const Running: Story = {
  parameters: {
    msw: {
      handlers: handlers(
        {
          status: "running",
          currentNodeId: "classify",
          ctx: {
            __input: { orderId: "ord_42", amount: 640 },
            enrich: { company: "Acme Corp", employees: 250 },
          },
        },
        pausedHistory.slice(0, 4),
      ),
    },
  },
};
