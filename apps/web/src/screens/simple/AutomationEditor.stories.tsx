import type { Meta, StoryObj } from "@storybook/react-vite";
import type { GraphDef } from "@naary/dsl";
import { http, HttpResponse } from "msw";
import { ModeProvider } from "../../mode";
import type { BudgetView, ConnectionRow } from "../../lib/api";
import { AutomationEditor } from "./AutomationEditor";

// A graph that exercises every beat: WHEN (trigger) → DO (agent) → ASK (approval gate,
// conditional) → THEN (an http step). The edge into the gate carries a condition so the
// "ONLY IF …" line renders.
const GRAPH: GraphDef = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "webhookTrigger", config: {} },
    {
      id: "agent",
      type: "agent",
      config: { prompt: "Assess the refund request and recommend an action." },
    },
    {
      id: "gate",
      type: "humanApproval",
      config: { title: "the refund before it is issued" },
    },
    {
      id: "notify",
      type: "httpRequest",
      config: { method: "POST", url: "https://api.acme.io/refunds" },
    },
    { id: "end", type: "end", config: {} },
  ],
  edges: [
    { from: "trigger", to: "agent" },
    {
      from: "agent",
      to: "gate",
      condition: { path: "agent.output.amount", op: "gt", value: 100 },
    },
    { from: "gate", to: "notify" },
    { from: "notify", to: "end" },
  ],
};

const CONNECTIONS = [
  {
    id: "conn-gh-1",
    type: "github",
    label: "GitHub App",
    serverUrl: "https://api.github.com",
    authMode: "oauth",
    scopes: [],
    status: "connected",
    createdAt: "2026-07-01T10:00:00.000Z",
  },
] satisfies ConnectionRow[];

const budgetWith = (perExecutionCapUsd: number): BudgetView => ({
  tenantId: "t1",
  monthlyCapUsd: 500,
  perExecutionCapUsd,
  maxStepsPerRun: 40,
  onBudgetExceeded: "pause",
  fallbackModel: null,
  alertThresholdPct: 80,
  mtdSpendUsd: 184.42,
  remainingUsd: 315.58,
});

const handlersFor = (perExecutionCapUsd: number) => [
  http.get("*/api/me", () =>
    HttpResponse.json({ tenantId: "t1", subject: "u1" }),
  ),
  http.get("*/api/tenants/:t/connections", () =>
    HttpResponse.json(CONNECTIONS),
  ),
  http.get("*/api/tenants/:t/budget", () =>
    HttpResponse.json(budgetWith(perExecutionCapUsd)),
  ),
];

const meta: Meta<typeof AutomationEditor> = {
  title: "Screens/AutomationEditor",
  component: AutomationEditor,
  args: {
    initialName: "Refund triage",
    initialGraph: GRAPH,
    workflowKey: "refund-triage",
  },
  parameters: {
    layout: "fullscreen",
    msw: { handlers: handlersFor(2.5) },
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
type Story = StoryObj<typeof AutomationEditor>;

/** The beat-block editor with a real per-run budget cap ("$2.50 / run" pill). */
export const Default: Story = {};

/** Same automation, no per-run cap configured → the honest "No per-run cap" pill. */
export const NoCap: Story = {
  parameters: { msw: { handlers: handlersFor(0) } },
};
