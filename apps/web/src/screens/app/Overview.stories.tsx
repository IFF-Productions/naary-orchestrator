import type { Meta, StoryObj } from "@storybook/react-vite";
import { delay, http, HttpResponse } from "msw";
import { Overview } from "./Overview";

/* Times are generated relative to "now" so the 24h sparkline, the failure/budget
 * windows, and the waiting-age chips light up deterministically in the story. */
const HOUR = 3_600_000;
const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const run = (
  workflowId: string,
  workflowKey: string | null,
  status: string,
  msAgo: number,
  costUsd: number | null = 0.01,
) => ({
  workflowId,
  workflowKey,
  status,
  costUsd,
  startedAt: at(msAgo),
  createdAt: at(msAgo),
  archived: false,
  graphVersion: 3,
});

// A spread across the 24h window: successes on two busy workflows, a failure,
// a timeout, a budget-stop, and one run older than 24h (excluded from the
// 24h-derived figures but still in the total run count).
const RUNS = [
  run("wh-t1-a01", "rag-support-bot", "completed", 0.4 * HOUR),
  run("wh-t1-a02", "rag-support-bot", "completed", 1.2 * HOUR),
  run("wh-t1-a03", "rag-support-bot", "running", 0.1 * HOUR, null),
  run("wh-t1-a04", "rag-support-bot", "completed", 3 * HOUR),
  run("wh-t1-a05", "rag-support-bot", "completed", 7 * HOUR),
  run("wh-t1-b01", "deal-won-notifier", "completed", 2 * HOUR),
  run("wh-t1-b02", "deal-won-notifier", "awaiting_approval", 5 * HOUR, null),
  run("wh-t1-b03", "deal-won-notifier", "completed", 11 * HOUR),
  run("wh-t1-c01", "hourly-lead-sync", "failed", 4 * HOUR, null),
  run("wh-t1-c02", "hourly-lead-sync", "timed_out", 9 * HOUR, null),
  run("wh-t1-d01", "incident-triage", "budget_exceeded", 6 * HOUR, 0.51),
  run("wh-t1-e01", "refund-approver", "awaiting_approval", 30 * HOUR, null),
  run("wh-t1-e02", "refund-approver", "completed", 36 * HOUR),
];

// Waiting ages chosen to hit all three chip tones: >24h (bad), >4h (warn), fresh.
const AWAITING = [
  {
    workflowId: "wh-t1-e01",
    workflowKey: "refund-approver",
    nodeId: "gate",
    title: "Approve $48,000 deal response",
    instructions: null,
    createdAt: at(30 * HOUR),
  },
  {
    workflowId: "wh-t1-b02",
    workflowKey: "deal-won-notifier",
    nodeId: "approve",
    title: "Grant prod DB read to intern",
    instructions: "Access request — expires in 7 days.",
    createdAt: at(5 * HOUR),
  },
  {
    workflowId: "wh-t1-f01",
    workflowKey: "invoice-ap",
    nodeId: "approve",
    title: "Approve $12,500 vendor invoice",
    instructions: null,
    createdAt: at(6 * HOUR),
  },
  {
    workflowId: "wh-t1-f02",
    workflowKey: "compliance-gate",
    nodeId: "gate",
    title: "Approve PII data export",
    instructions: null,
    createdAt: at(0.5 * HOUR),
  },
];

const AUDIT = [
  {
    id: "a1",
    actor: "sam@acme.io",
    action: "Approved a paused run",
    method: "POST",
    path: "/executions/wh-t1-old/approve",
    statusCode: 200,
    createdAt: at(0.2 * HOUR),
  },
  {
    id: "a2",
    actor: "ada@northwind.io",
    action: "Saved workflow deal-won-notifier (v8)",
    method: "PUT",
    path: "/tenants/t1/graphs/deal-won-notifier",
    statusCode: 200,
    createdAt: at(2 * HOUR),
  },
  {
    id: "a3",
    actor: "token:ci-deploy",
    action: "Started an execution",
    method: "POST",
    path: "/executions",
    statusCode: 429,
    createdAt: at(3 * HOUR),
  },
  {
    id: "a4",
    actor: "ada@northwind.io",
    action: "Added a Slack notification channel",
    method: "POST",
    path: "/tenants/t1/notification-channels",
    statusCode: 201,
    createdAt: at(8 * HOUR),
  },
  {
    id: "a5",
    actor: "maria@northwind.io",
    action: "Viewed the audit log",
    method: "GET",
    path: "/tenants/t1/audit",
    statusCode: 200,
    createdAt: at(26 * HOUR),
  },
];

const handlers = [
  http.get("*/api/executions", () => HttpResponse.json(RUNS)),
  http.get("*/api/executions/awaiting", () => HttpResponse.json(AWAITING)),
  http.get("*/api/me", () => HttpResponse.json({ tenantId: "t1" })),
  http.get("*/api/tenants/:t/audit", () => HttpResponse.json(AUDIT)),
  http.post("*/api/executions/:id/approve", () =>
    HttpResponse.json({ accepted: true }),
  ),
];

const meta: Meta<typeof Overview> = {
  title: "Screens/Overview",
  component: Overview,
  parameters: {
    layout: "fullscreen",
    msw: { handlers },
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
type Story = StoryObj<typeof Overview>;

/** The populated dashboard — hero attention row, decide-in-place queue, 24h
 *  sparkline, activity feed, and the busiest-workflows strip. */
export const Populated: Story = {};

/** A brand-new workspace — every card in its honest empty state. */
export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/executions", () => HttpResponse.json([])),
        http.get("*/api/executions/awaiting", () => HttpResponse.json([])),
        http.get("*/api/me", () => HttpResponse.json({ tenantId: "t1" })),
        http.get("*/api/tenants/:t/audit", () => HttpResponse.json([])),
      ],
    },
  },
};

/** Still loading — responses never resolve. */
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/executions", async () => {
          await delay("infinite");
          return HttpResponse.json([]);
        }),
        http.get("*/api/executions/awaiting", async () => {
          await delay("infinite");
          return HttpResponse.json([]);
        }),
        http.get("*/api/me", async () => {
          await delay("infinite");
          return HttpResponse.json({ tenantId: "t1" });
        }),
      ],
    },
  },
};
