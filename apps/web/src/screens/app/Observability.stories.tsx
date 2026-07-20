import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { Observability } from "./Observability";

// Fixture times are offsets from "now" so the 24h/7d/30d windows and relative
// timestamps stay meaningful whenever the story is opened.
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const day = (d: number) =>
  new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);

const BASE_RUNS = [
  {
    workflowId: "wh-t1-a1f9c2",
    workflowKey: "deal-won-notifier",
    status: "completed",
    costUsd: 0.0025,
    startedAt: ago(0.05),
    createdAt: ago(0.05),
    archived: false,
    graphVersion: 8,
  },
  {
    workflowId: "wh-t1-9d2c71",
    workflowKey: "refund-approver",
    status: "awaiting_approval",
    costUsd: 0.0004,
    startedAt: ago(1),
    createdAt: ago(1),
    archived: false,
    graphVersion: 3,
  },
  {
    workflowId: "wh-t1-7b0433",
    workflowKey: "rag-support-bot",
    status: "completed",
    costUsd: 0.0018,
    startedAt: ago(2),
    createdAt: ago(2),
    archived: false,
    graphVersion: 5,
  },
  {
    workflowId: "wh-t1-5e8190",
    workflowKey: "nightly-digest",
    status: "running",
    costUsd: null,
    startedAt: ago(0.01),
    createdAt: ago(0.01),
    archived: false,
    graphVersion: 2,
  },
  {
    workflowId: "wh-t1-3a12ff",
    workflowKey: "incident-triage",
    status: "timed_out",
    costUsd: 0.0031,
    startedAt: ago(3),
    createdAt: ago(3),
    archived: false,
    graphVersion: 4,
  },
  {
    workflowId: "wh-t1-2c88de",
    workflowKey: "rag-support-bot",
    status: "completed",
    costUsd: 0.0016,
    startedAt: ago(28),
    createdAt: ago(28),
    archived: false,
    graphVersion: 5,
  },
  {
    workflowId: "wh-t1-1b77aa",
    workflowKey: "invoice-ap",
    status: "budget_exceeded",
    costUsd: 0.51,
    startedAt: ago(40),
    createdAt: ago(40),
    archived: false,
    graphVersion: 7,
  },
  {
    workflowId: "wh-t1-0f34cc",
    workflowKey: "deal-won-notifier",
    status: "completed",
    costUsd: 0.0022,
    startedAt: ago(70),
    createdAt: ago(70),
    archived: false,
    graphVersion: 8,
  },
  {
    workflowId: "wh-t1-e410bb",
    workflowKey: "invoice-ap",
    status: "failed",
    costUsd: null,
    startedAt: ago(90),
    createdAt: ago(90),
    archived: false,
    graphVersion: 7,
  },
];

// Slice 2: worker-stamped durations + failureKind per run. In-flight rows stay null;
// "wh-t1-e410bb" is deliberately a PRE-FEATURE failure (no stamp → duration "—",
// failure reason falls back to its close status).
const SLICE2: Record<
  string,
  { durationMs: number | null; failureKind: string | null }
> = {
  "wh-t1-a1f9c2": { durationMs: 9_400, failureKind: null },
  "wh-t1-7b0433": { durationMs: 3_100, failureKind: null },
  "wh-t1-3a12ff": { durationMs: 600_000, failureKind: "timeout" },
  "wh-t1-2c88de": { durationMs: 2_800, failureKind: null },
  "wh-t1-1b77aa": { durationMs: 45_000, failureKind: "budget" },
  "wh-t1-0f34cc": { durationMs: 8_200, failureKind: null },
};

const RUNS = BASE_RUNS.map((r) => {
  const s = SLICE2[r.workflowId];
  const durationMs = s?.durationMs ?? null;
  return {
    ...r,
    finishedAt:
      durationMs !== null
        ? new Date(new Date(r.createdAt).getTime() + durationMs).toISOString()
        : null,
    durationMs,
    failureKind: s?.failureKind ?? null,
  };
});

const INSIGHTS = {
  range: { from: day(7), to: null },
  totals: { costUsd: 1.8421, totalTokens: 412_400, calls: 302 },
  byDay: Array.from({ length: 7 }, (_, i) => ({
    date: day(6 - i),
    costUsd: 0.1 + i * 0.05,
    totalTokens: 40_000 + i * 8_000,
    calls: 30 + i * 6,
  })),
  byEnvironment: [
    { environmentId: "prod", costUsd: 1.4, totalTokens: 300_000, calls: 220 },
    {
      environmentId: "sandbox",
      costUsd: 0.44,
      totalTokens: 112_400,
      calls: 82,
    },
  ],
  byWorkflow: [
    {
      workflowKey: "rag-support-bot",
      costUsd: 0.92,
      totalTokens: 210_000,
      calls: 140,
    },
    {
      workflowKey: "deal-won-notifier",
      costUsd: 0.51,
      totalTokens: 120_000,
      calls: 90,
    },
    {
      workflowKey: "invoice-ap",
      costUsd: 0.28,
      totalTokens: 60_000,
      calls: 48,
    },
    {
      workflowKey: "incident-triage",
      costUsd: 0.13,
      totalTokens: 22_400,
      calls: 24,
    },
  ],
  byModel: [
    {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      costUsd: 1.6,
      totalTokens: 380_000,
      calls: 260,
    },
  ],
  // Slice 2 rollups: ledger node-type buckets + un-capped run-outcome days.
  byNodeType: [
    {
      nodeType: "agent",
      costUsd: 1.7,
      totalTokens: 400_000,
      calls: 280,
      avgDurationMs: 1_840,
    },
    {
      nodeType: "vectorQuery",
      costUsd: 0.14,
      totalTokens: 12_400,
      calls: 22,
      avgDurationMs: 420,
    },
  ],
  runsByDay: Array.from({ length: 7 }, (_, i) => ({
    date: day(6 - i),
    total: 40 + i * 4,
    byStatus: {
      completed: 34 + i * 4,
      failed: 3,
      awaiting_approval: 2,
      timed_out: 1,
    },
  })),
  runsByWorkflow: [
    { workflowKey: "rag-support-bot", runs: 140, avgDurationMs: 3_400 },
    { workflowKey: "deal-won-notifier", runs: 96, avgDurationMs: 8_900 },
    { workflowKey: "invoice-ap", runs: 52, avgDurationMs: 41_000 },
    { workflowKey: "incident-triage", runs: 24, avgDurationMs: null },
  ],
  failureKinds: [
    { kind: "timeout", count: 7 },
    { kind: "budget", count: 4 },
    { kind: "upstream_5xx", count: 3 },
  ],
};

const AUDIT = [
  {
    id: "a1",
    actor: "m.alvarez@acme.io",
    action: "Saved a workflow",
    method: "POST",
    path: "/tenants/t1/graphs",
    statusCode: 201,
    createdAt: ago(0.05),
  },
  {
    id: "a2",
    actor: "sam@acme.io",
    action: "Decided an approval",
    method: "POST",
    path: "/executions/wh-t1-9d2c71/approve",
    statusCode: 202,
    createdAt: ago(1),
  },
  {
    id: "a3",
    actor: "j.park@acme.io",
    action: "Started a run",
    method: "POST",
    path: "/executions",
    statusCode: 201,
    createdAt: ago(3),
  },
  {
    id: "a4",
    actor: "m.alvarez@acme.io",
    action: "Saved a provider key",
    method: "PUT",
    path: "/tenants/t1/credentials",
    statusCode: 200,
    createdAt: ago(5),
  },
  {
    id: "a5",
    actor: "api-token",
    action: "Created a schedule",
    method: "POST",
    path: "/tenants/t1/schedules",
    statusCode: 201,
    createdAt: ago(26),
  },
  {
    id: "a6",
    actor: "m.alvarez@acme.io",
    action: "Invited a member",
    method: "POST",
    path: "/tenants/t1/members",
    statusCode: 201,
    createdAt: ago(50),
  },
  {
    id: "a7",
    actor: "ada@acme.io",
    action: "Updated notifications",
    method: "PUT",
    path: "/tenants/t1/notifications",
    statusCode: 200,
    createdAt: ago(52),
  },
];

const handlers = [
  http.get("*/api/me", () => HttpResponse.json({ tenantId: "t1" })),
  http.get("*/api/executions", () => HttpResponse.json(RUNS)),
  http.get("*/api/tenants/:t/usage/insights", () =>
    HttpResponse.json(INSIGHTS),
  ),
  http.get("*/api/tenants/:t/audit", () => HttpResponse.json(AUDIT)),
];

const meta: Meta<typeof Observability> = {
  title: "Screens/Observe",
  component: Observability,
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
type Story = StoryObj<typeof Observability>;

/** Insights tab (default) — KPIs, throughput lines, outcome donut, failure reasons, spend. */
export const Insights: Story = {
  parameters: { router: { initialEntries: ["/app/observability"] } },
};

/** Runs & logs tab — the runs table with glow-dot statuses (deep-linked via ?tab=runs). */
export const RunsAndLogs: Story = {
  parameters: { router: { initialEntries: ["/app/observability?tab=runs"] } },
};

/** Audit tab — actor/action rows with type-accent tiles + family filter chips (?tab=audit). */
export const Audit: Story = {
  parameters: { router: { initialEntries: ["/app/observability?tab=audit"] } },
};

/** Nothing recorded yet — every tab's empty state. */
export const Empty: Story = {
  parameters: {
    router: { initialEntries: ["/app/observability"] },
    msw: {
      handlers: [
        http.get("*/api/me", () => HttpResponse.json({ tenantId: "t1" })),
        http.get("*/api/executions", () => HttpResponse.json([])),
        http.get("*/api/tenants/:t/usage/insights", () =>
          HttpResponse.json({
            range: { from: null, to: null },
            totals: { costUsd: 0, totalTokens: 0, calls: 0 },
            byDay: [],
            byEnvironment: [],
            byWorkflow: [],
            byModel: [],
          }),
        ),
        http.get("*/api/tenants/:t/audit", () => HttpResponse.json([])),
      ],
    },
  },
};
