import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { expect, userEvent, waitFor, within } from "storybook/test";
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

// A run that FAILED at the agent (#525): enrich ran, the agent activity failed with a
// provider-credential error, the run failed. The `error` event carries the failure detail.
const failedHistory: RunEvent[] = [
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
    at: "2026-07-17T09:20:02Z",
  },
  {
    id: 5,
    kind: "error",
    label: "Activity failed",
    detail: "Missing or invalid provider credential",
    at: "2026-07-17T09:20:03Z",
  },
  {
    id: 6,
    kind: "error",
    label: "Run failed",
    detail: "Activity task failed",
    at: "2026-07-17T09:20:03Z",
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

/** A completed run — green hero, fully-green executed path, per-step outputs,
 *  and the Slice-2 per-node timing map (proportional duration bars + per-step
 *  duration/cost/tokens in the timeline + detail card). */
export const Completed: Story = {
  parameters: {
    msw: {
      handlers: handlers(
        {
          status: "completed",
          currentNodeId: "end",
          ctx: {
            ...CTX_UP_TO_ROUTE,
            // The agent's real result shape carries its own metered cost/tokens.
            classify: {
              ...CTX_UP_TO_ROUTE.classify,
              costUsd: 0.0021,
              totalTokens: 1840,
            },
            approve: { approved: true },
            refund: { refunded: true, id: "re_123", costUsd: 0.005 },
            end: {},
            __costUsd: 0.0142,
          },
          // Worker-stamped per-node windows (epoch ms, workflow time).
          nodeTimes: (() => {
            const t0 = Date.parse("2026-07-17T09:20:00Z");
            const dec = Date.parse("2026-07-18T11:41:00Z"); // approval decided
            return {
              start: { s: t0, f: t0 },
              enrich: { s: t0 + 500, f: t0 + 1400 },
              classify: { s: t0 + 1400, f: t0 + 3900 },
              route: { s: t0 + 3900, f: t0 + 3900 },
              approve: { s: t0 + 3900, f: dec },
              refund: { s: dec, f: dec + 1200 },
              end: { s: dec + 1200, f: dec + 1200 },
            };
          })(),
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

/** Failed AT the agent (#525): the run threw, so its ctx came back EMPTY — but the
 *  interpreter stamped `currentNodeId` = the failed node + `executedNodeIds` = the nodes
 *  that ran. So the agent shows FAILED (with its error), upstream nodes show done, and the
 *  full log lives in the run-level Execution log — not under the step. */
export const Failed: Story = {
  parameters: {
    msw: {
      handlers: handlers(
        {
          status: "failed",
          currentNodeId: "classify", // the node the run died on
          ctx: {}, // a thrown run's ctx isn't recoverable — the real empty case
          executedNodeIds: ["enrich"], // stamped: enrich had run before the agent failed
        },
        failedHistory,
      ),
    },
  },
};

/**
 * **The failed run with its re-run menu OPEN — a state no story opened.**
 *
 * `Failed` is the only terminal state that also renders "Resume", which makes the action row WRAP
 * on a phone and leaves the Re-run group short of the right edge. `RerunMenu`'s popover is
 * `position: absolute; right: 0` at a fixed `minWidth: 272`, so it grows leftwards from whatever x
 * the anchor happens to sit at — measured at 390×844 before the fix, `left: -121`. `global.css`
 * clamps the root with `overflow-x: hidden`, so those 121px are not scrollable-to, they are gone:
 * the debug item and every version row lost their left third, including the "v4 latest" labels
 * that say WHICH version you are about to run.
 *
 * Reproduces at 390 and 375, and NOT at 1440 (left: 1140 there) — the anchor's x drives it. Only
 * the failed run wraps, which is why `Completed` (left: 28) read clean in every previous sweep.
 */
export const FailedRerunMenuOpen: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/graphs/:key/versions", () =>
          HttpResponse.json([
            { version: 4, createdAt: "2026-07-17T08:00:00Z" },
            { version: 3, createdAt: "2026-07-16T08:00:00Z" },
            { version: 2, createdAt: "2026-07-10T08:00:00Z" },
          ]),
        ),
        ...handlers(
          {
            status: "failed",
            currentNodeId: "classify",
            ctx: {},
            executedNodeIds: ["enrich"],
          },
          failedHistory,
        ),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const caret = () =>
      canvas.getByRole("button", { name: "More re-run options" });
    await waitFor(() => expect(caret()).toBeEnabled(), { timeout: 8000 });
    await userEvent.click(caret());
    await waitFor(() =>
      expect(canvasElement.querySelector(".menu-pop")).toBeTruthy(),
    );
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
