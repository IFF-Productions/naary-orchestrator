import type { Meta, StoryObj } from "@storybook/react-vite";
import type { GraphDef } from "@naary/dsl";
import { delay, http, HttpResponse } from "msw";
import { ModeProvider } from "../../mode";
import type {
  ExecutionState,
  NamedGraph,
  RunEvent,
  RunSummary,
} from "../../lib/api";
import { AutomationDetail } from "./AutomationDetail";

// WHEN (webhook) → DO (agent) → ASK (approval) → THEN (end). The run below pauses on the
// gate, so the checklist reads trigger✓ agent✓ gate⧗ end… — genuine progress.
const GRAPH: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger", config: {} },
    { id: "agent", type: "agent", config: { prompt: "Triage the refund" } },
    {
      id: "gate",
      type: "humanApproval",
      config: { title: "Approve the refund before it is issued" },
    },
    { id: "end", type: "end", config: {} },
  ],
  edges: [
    { from: "trigger", to: "agent" },
    { from: "agent", to: "gate" },
    { from: "gate", to: "end" },
  ],
};

const NAMED = {
  workflowKey: "refund-triage",
  name: "Refund triage",
  version: 3,
  graph: GRAPH,
} satisfies NamedGraph;

const RUN_ID = "wh-run-1";
const START_MS = Date.parse("2026-07-16T09:20:00.000Z");

const RUN = {
  workflowId: RUN_ID,
  workflowKey: "refund-triage",
  status: "awaiting_approval",
  costUsd: 0.0142,
  startedAt: "2026-07-16T09:20:00.000Z",
  createdAt: "2026-07-16T09:20:00.000Z",
  finishedAt: null,
  durationMs: null,
  failureKind: null,
  archived: false,
  graphVersion: 3,
} satisfies RunSummary;

// Paused on the gate. `ctx` keys that are node ids mark those nodes "done" (the trigger is
// auto-marked because the run exists) → trigger + agent read done, gate waiting, end pending.
const STATE = {
  status: "awaiting_approval",
  currentNodeId: "gate",
  ctx: {
    __input: { amount: 240 },
    agent: { output: { recommendation: "refund", amount: 240 } },
  },
  nodeTimes: {
    trigger: { s: START_MS, f: START_MS + 200 },
    agent: { s: START_MS + 200, f: START_MS + 4200 },
  },
  spentUsd: 0.0142,
  perExecutionCapUsd: 2.5,
} satisfies ExecutionState;

const HISTORY = [
  {
    id: 1,
    kind: "started",
    label: "Run started",
    at: "2026-07-16T09:20:00.000Z",
  },
  {
    id: 2,
    kind: "activity",
    label: "Agent completed",
    at: "2026-07-16T09:20:04.000Z",
  },
  {
    id: 3,
    kind: "signal",
    label: "Waiting for approval",
    at: "2026-07-16T09:20:04.500Z",
  },
] satisfies RunEvent[];

const graphHandler = http.get("*/api/graphs/:key", () =>
  HttpResponse.json(NAMED),
);

const runViewHandlers = [
  http.get("*/api/executions/:id/history", () => HttpResponse.json(HISTORY)),
  http.get("*/api/executions/:id/graph", () =>
    HttpResponse.json({
      graph: GRAPH,
      version: 3,
      workflowKey: "refund-triage",
    }),
  ),
  http.get("*/api/executions/:id", () => HttpResponse.json(STATE)),
];

const meta: Meta<typeof AutomationDetail> = {
  title: "Screens/AutomationDetail",
  component: AutomationDetail,
  parameters: {
    layout: "fullscreen",
    router: {
      path: "/app/automations/:key",
      initialEntries: ["/app/automations/refund-triage"],
    },
  },
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
type Story = StoryObj<typeof AutomationDetail>;

/** The automation has never run — its steps preview + "Test it" (listRuns → []). */
export const HasNotRun: Story = {
  parameters: {
    msw: {
      handlers: [
        graphHandler,
        http.get("*/api/executions", () => HttpResponse.json([])),
      ],
    },
  },
};

/** A live run paused on the approval gate: the WAITING hero with Approve/Reject, the
 *  step checklist (trigger + agent done, gate waiting), and the cost/budget footer. */
export const LiveRun: Story = {
  parameters: {
    msw: {
      handlers: [
        graphHandler,
        http.get("*/api/executions", () => HttpResponse.json([RUN])),
        ...runViewHandlers,
      ],
    },
  },
};

/** Still loading the automation — the "Loading…" message (getGraph never resolves). */
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/graphs/:key", async () => {
          await delay("infinite");
          return HttpResponse.json(NAMED);
        }),
        http.get("*/api/executions", () => HttpResponse.json([RUN])),
      ],
    },
  },
};

/** Unauthenticated: the run resolves but its state is 401 → "Sign in to see this run." */
export const Unauthorized: Story = {
  parameters: {
    msw: {
      handlers: [
        graphHandler,
        http.get("*/api/executions", () => HttpResponse.json([RUN])),
        http.get("*/api/executions/:id/history", () => HttpResponse.json([])),
        http.get("*/api/executions/:id/graph", () =>
          HttpResponse.json({
            graph: GRAPH,
            version: 3,
            workflowKey: "refund-triage",
          }),
        ),
        http.get(
          "*/api/executions/:id",
          () => new HttpResponse(null, { status: 401 }),
        ),
      ],
    },
  },
};
