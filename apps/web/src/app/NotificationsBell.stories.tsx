import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { http, HttpResponse } from "msw";
import { NotificationsBell } from "./NotificationsBell";

// Two approvals + a couple of failed runs — the exact events the bell surfaces. Served via MSW
// (see parameters.msw.handlers) so the real `api` fetches resolve against these, no backend.
const AWAITING = [
  {
    workflowId: "wh-t1-9a8b7c",
    workflowKey: "refund-triage",
    nodeId: "approve",
    title: "Refund over $500",
    instructions: null,
    createdAt: new Date("2026-07-16T09:05:00Z").toISOString(),
  },
  {
    workflowId: "wh-t1-farfar",
    workflowKey: "invoice-sync",
    nodeId: "gate",
    title: "Vendor payout",
    instructions: null,
    createdAt: new Date("2026-07-16T08:40:00Z").toISOString(),
  },
];

const RUNS = [
  {
    workflowId: "wh-t1-deadbeef",
    workflowKey: "github-pr-ai-review",
    status: "failed",
    costUsd: null,
    startedAt: new Date("2026-07-16T09:07:00Z").toISOString(),
    createdAt: new Date("2026-07-16T09:07:00Z").toISOString(),
    archived: false,
    graphVersion: 3,
  },
  {
    workflowId: "wh-t1-cafe12",
    workflowKey: "nightly-digest",
    status: "timed_out",
    costUsd: 0.02,
    startedAt: new Date("2026-07-16T07:15:00Z").toISOString(),
    createdAt: new Date("2026-07-16T07:15:00Z").toISOString(),
    archived: false,
    graphVersion: 5,
  },
  {
    workflowId: "wh-t1-0f0f0f",
    workflowKey: "lead-router",
    status: "completed",
    costUsd: 0.01,
    startedAt: new Date("2026-07-16T06:00:00Z").toISOString(),
    createdAt: new Date("2026-07-16T06:00:00Z").toISOString(),
    archived: false,
    graphVersion: 1,
  },
];

const handlers = [
  http.get("*/api/executions/awaiting", () => HttpResponse.json(AWAITING)),
  http.get("*/api/executions", () => HttpResponse.json(RUNS)),
];

const meta: Meta<typeof NotificationsBell> = {
  title: "App chrome/NotificationsBell",
  component: NotificationsBell,
  parameters: { msw: { handlers } },
  decorators: [
    (Story) => (
      // A slice of the topbar so the bell + its dropdown sit on the app surface.
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          padding: 16,
          background: "var(--bg-2)",
          minHeight: 420,
        }}
      >
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof NotificationsBell>;

/** Closed bell — the unread badge reflects the mocked approvals + failed runs. */
export const WithUnread: Story = {};

/** The open dropdown, populated from the mocked API. */
export const OpenPanel: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bell = await canvas.findByRole("button", { name: /Notifications/ });
    await userEvent.click(bell);
    const menu = await canvas.findByRole("menu");
    // The mocked approval surfaces in the open panel (proves MSW fed the fetch).
    await waitFor(() =>
      expect(within(menu).getByText(/Refund over \$500/)).toBeTruthy(),
    );
  },
};

/** No approvals, no failures — the empty state. */
export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/executions/awaiting", () => HttpResponse.json([])),
        http.get("*/api/executions", () => HttpResponse.json([])),
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bell = await canvas.findByRole("button", { name: /Notifications/ });
    await userEvent.click(bell);
    await canvas.findByRole("menu");
  },
};
