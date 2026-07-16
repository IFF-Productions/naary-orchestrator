import type { Meta, StoryObj } from "@storybook/react-vite";
import { delay, http, HttpResponse } from "msw";
import { ModeProvider } from "../../mode";
import { Runs } from "./Runs";

// A spread of run statuses so the pills, cost column, and bulk-action affordances all show.
const RUNS = [
  {
    workflowId: "wh-t1-a1b2c3",
    workflowKey: "refund-triage",
    status: "completed",
    costUsd: 0.0142,
    startedAt: new Date("2026-07-16T09:20:00Z").toISOString(),
    createdAt: new Date("2026-07-16T09:20:00Z").toISOString(),
    archived: false,
    graphVersion: 3,
  },
  {
    workflowId: "wh-t1-d4e5f6",
    workflowKey: "github-pr-ai-review",
    status: "running",
    costUsd: null,
    startedAt: new Date("2026-07-16T09:12:00Z").toISOString(),
    createdAt: new Date("2026-07-16T09:12:00Z").toISOString(),
    archived: false,
    graphVersion: 3,
  },
  {
    workflowId: "wh-t1-9a8b7c",
    workflowKey: "refund-triage",
    status: "awaiting_approval",
    costUsd: 0.089,
    startedAt: new Date("2026-07-16T08:50:00Z").toISOString(),
    createdAt: new Date("2026-07-16T08:50:00Z").toISOString(),
    archived: false,
    graphVersion: 3,
  },
  {
    workflowId: "wh-t1-deadbeef",
    workflowKey: "invoice-sync",
    status: "failed",
    costUsd: null,
    startedAt: new Date("2026-07-16T08:30:00Z").toISOString(),
    createdAt: new Date("2026-07-16T08:30:00Z").toISOString(),
    archived: false,
    graphVersion: 7,
  },
  {
    workflowId: "wh-t1-cafe12",
    workflowKey: "nightly-digest",
    status: "budget_exceeded",
    costUsd: 0.51,
    startedAt: new Date("2026-07-16T07:00:00Z").toISOString(),
    createdAt: new Date("2026-07-16T07:00:00Z").toISOString(),
    archived: false,
    graphVersion: 5,
  },
];

const meta: Meta<typeof Runs> = {
  title: "Screens/Runs",
  component: Runs,
  parameters: {
    layout: "fullscreen",
    msw: {
      handlers: [http.get("*/api/executions", () => HttpResponse.json(RUNS))],
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
type Story = StoryObj<typeof Runs>;

/** The populated Runs list — a spread of statuses across the pills + cost column. */
export const Populated: Story = {};

/** No runs yet — the empty state. */
export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [http.get("*/api/executions", () => HttpResponse.json([]))],
    },
  },
};

/** Still loading — the skeleton rows (response never resolves). */
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/executions", async () => {
          await delay("infinite");
          return HttpResponse.json([]);
        }),
      ],
    },
  },
};

/** Unauthenticated (401) — the "sign in / set a token" error state. */
export const Unauthorized: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get(
          "*/api/executions",
          () => new HttpResponse(null, { status: 401 }),
        ),
      ],
    },
  },
};
