import type { Meta, StoryObj } from "@storybook/react-vite";
import type { GraphDef } from "@naary/dsl";
import { delay, http, HttpResponse } from "msw";
import { ModeProvider } from "../../mode";
import type { GraphSummary, NamedGraph, RunSummary } from "../../lib/api";
import { Automations } from "./Automations";

// A real linear automation: WHEN (webhook) → DO (agent) → ASK (approval) → THEN (end).
// Drives both the plain-language summary and the node-chain strip on each card.
const GRAPH: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger", config: {} },
    { id: "agent", type: "agent", config: { prompt: "Triage the request" } },
    { id: "gate", type: "humanApproval", config: { title: "Approve refund" } },
    { id: "end", type: "end", config: {} },
  ],
  edges: [
    { from: "trigger", to: "agent" },
    { from: "agent", to: "gate" },
    { from: "gate", to: "end" },
  ],
};

const SCHEDULE_GRAPH: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "scheduleTrigger", config: { cron: "0 6 * * *" } },
    { id: "agent", type: "agent", config: { prompt: "Write the digest" } },
    { id: "end", type: "end", config: {} },
  ],
  edges: [
    { from: "trigger", to: "agent" },
    { from: "agent", to: "end" },
  ],
};

const SUMMARIES = [
  {
    workflowKey: "refund-triage",
    name: "Refund triage",
    version: 3,
    updatedAt: "2026-07-15T09:00:00.000Z",
    active: true,
    tags: [{ id: "tag-billing", name: "billing", color: "#4a9dff" }],
  },
  {
    workflowKey: "nightly-digest",
    name: "Nightly digest",
    version: 5,
    updatedAt: "2026-07-14T09:00:00.000Z",
    active: false,
    tags: [],
  },
  {
    workflowKey: "lead-router",
    name: "Lead router",
    version: 1,
    updatedAt: "2026-07-16T09:00:00.000Z",
    active: true,
    tags: [],
  },
] satisfies GraphSummary[];

const GRAPH_BY_KEY: Record<string, GraphDef> = {
  "refund-triage": GRAPH,
  "nightly-digest": SCHEDULE_GRAPH,
  "lead-router": GRAPH,
};

const NAMES: Record<string, string> = {
  "refund-triage": "Refund triage",
  "nightly-digest": "Nightly digest",
  "lead-router": "Lead router",
};

const RUNS = [
  {
    workflowId: "wh-t1-a1b2c3",
    workflowKey: "refund-triage",
    status: "completed",
    costUsd: 0.0142,
    startedAt: "2026-07-16T09:20:00.000Z",
    createdAt: "2026-07-16T09:20:00.000Z",
    finishedAt: "2026-07-16T09:20:12.000Z",
    durationMs: 12_000,
    failureKind: null,
    archived: false,
    graphVersion: 3,
  },
  {
    workflowId: "wh-t1-9a8b7c",
    workflowKey: "nightly-digest",
    status: "completed",
    costUsd: 0.31,
    startedAt: "2026-07-15T06:00:00.000Z",
    createdAt: "2026-07-15T06:00:00.000Z",
    finishedAt: "2026-07-15T06:00:40.000Z",
    durationMs: 40_000,
    failureKind: null,
    archived: false,
    graphVersion: 5,
  },
] satisfies RunSummary[];

const baseHandlers = [
  http.get("*/api/me", () =>
    HttpResponse.json({ tenantId: "t1", subject: "u1" }),
  ),
  http.get("*/api/graphs", () => HttpResponse.json(SUMMARIES)),
  http.get("*/api/executions", () => HttpResponse.json(RUNS)),
  http.get("*/api/graphs/:key", ({ params }) => {
    const key = String(params.key);
    return HttpResponse.json({
      workflowKey: key,
      name: NAMES[key] ?? key,
      version: 1,
      graph: GRAPH_BY_KEY[key] ?? GRAPH,
    } satisfies NamedGraph);
  }),
];

const meta: Meta<typeof Automations> = {
  title: "Screens/Automations",
  component: Automations,
  parameters: { layout: "fullscreen", msw: { handlers: baseHandlers } },
  decorators: [
    (Story) => (
      <ModeProvider>
        <div style={{ background: "var(--bg)", minHeight: "100vh" }}>
          <Story />
        </div>
      </ModeProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof Automations>;

/** Simple-mode home: automation cards with On/Paused badges + toggles, plain-language
 *  summaries, node-chain strips, and real "ran … ago" from the runs list. */
export const Populated: Story = {};

/** No automations yet — the "Create your first" empty state. */
export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/graphs", () => HttpResponse.json([])),
        ...baseHandlers,
      ],
    },
  },
};

/** Still loading the automations — the "Loading…" header (graphs never resolve). */
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/graphs", async () => {
          await delay("infinite");
          return HttpResponse.json([]);
        }),
        ...baseHandlers,
      ],
    },
  },
};

/** Unauthenticated (listGraphs 401) — "Sign in to see your automations." */
export const Unauthorized: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/graphs", () => new HttpResponse(null, { status: 401 })),
        ...baseHandlers,
      ],
    },
  },
};
