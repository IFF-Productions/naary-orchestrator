import type { Meta, StoryObj } from "@storybook/react-vite";
import { delay, http, HttpResponse } from "msw";
import { ModeProvider } from "../../mode";
import { Runs } from "./Runs";

// A spread of run statuses so the pills, cost, duration, and bulk-action affordances
// all show. Slice 2 fields: finishedAt/durationMs on terminal runs the worker stamped
// (null on in-flight + pre-feature rows → "—"), failureKind on classified failures.
const RUNS = [
  {
    workflowId: "wh-t1-a1b2c3",
    workflowKey: "refund-triage",
    status: "completed",
    costUsd: 0.0142,
    startedAt: new Date("2026-07-16T09:20:00Z").toISOString(),
    createdAt: new Date("2026-07-16T09:20:00Z").toISOString(),
    finishedAt: new Date("2026-07-16T09:20:12Z").toISOString(),
    durationMs: 12_000,
    failureKind: null,
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
    finishedAt: null,
    durationMs: null,
    failureKind: null,
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
    finishedAt: null,
    durationMs: null,
    failureKind: null,
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
    finishedAt: new Date("2026-07-16T08:31:24Z").toISOString(),
    durationMs: 84_000,
    failureKind: "upstream_5xx",
    archived: false,
    graphVersion: 7,
  },
  {
    // Pre-feature terminal row: no worker stamp → duration renders "—".
    workflowId: "wh-t1-cafe12",
    workflowKey: "nightly-digest",
    status: "budget_exceeded",
    costUsd: 0.51,
    startedAt: new Date("2026-07-16T07:00:00Z").toISOString(),
    createdAt: new Date("2026-07-16T07:00:00Z").toISOString(),
    finishedAt: null,
    durationMs: null,
    failureKind: "budget",
    archived: false,
    graphVersion: 5,
  },
  {
    // Slice 3 pause-not-fail: parked on budget (policy "pause") — an amber PAUSED
    // chip, not an error; it resumes on cap raise / month rollover.
    workflowId: "wh-t1-b0dget",
    workflowKey: "rag-support-bot",
    status: "awaiting_budget",
    costUsd: 0.31,
    startedAt: new Date("2026-07-16T09:45:00Z").toISOString(),
    createdAt: new Date("2026-07-16T09:45:00Z").toISOString(),
    finishedAt: null,
    durationMs: null,
    failureKind: null,
    archived: false,
    graphVersion: 4,
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
