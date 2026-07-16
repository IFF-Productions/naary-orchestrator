import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { ModeProvider } from "../../mode";
import { Workflows } from "./Workflows";

const GRAPHS = [
  {
    workflowKey: "refund-triage",
    name: "Refund triage",
    version: 3,
    updatedAt: new Date("2026-07-16T09:00:00Z").toISOString(),
    active: true,
  },
  {
    workflowKey: "github-pr-ai-review",
    name: "GitHub PR reviewer",
    version: 7,
    updatedAt: new Date("2026-07-15T18:00:00Z").toISOString(),
    active: true,
  },
  {
    workflowKey: "lead-router",
    name: "Lead router",
    version: 1,
    updatedAt: new Date("2026-07-10T12:00:00Z").toISOString(),
    active: false,
  },
];

// A few runs per workflow so the success-rate + last-run columns compute.
const RUNS = [
  { workflowKey: "refund-triage", status: "completed" },
  { workflowKey: "refund-triage", status: "completed" },
  { workflowKey: "refund-triage", status: "failed" },
  { workflowKey: "github-pr-ai-review", status: "completed" },
  { workflowKey: "lead-router", status: "failed" },
].map((r, i) => ({
  workflowId: `wh-t1-${i}`,
  workflowKey: r.workflowKey,
  status: r.status,
  costUsd: 0.01,
  startedAt: new Date(2026, 6, 16, 9, i).toISOString(),
  createdAt: new Date(2026, 6, 16, 9, i).toISOString(),
  archived: false,
  graphVersion: 1,
}));

const baseHandlers = [
  http.get("*/api/graphs", () => HttpResponse.json(GRAPHS)),
  http.get("*/api/executions", () => HttpResponse.json(RUNS)),
  http.get("*/api/me", () =>
    HttpResponse.json({ userId: "u1", email: "a@b.co", tenantId: "t1" }),
  ),
  http.get("*/api/tenants/:t/environments", () =>
    HttpResponse.json([
      { id: "e-prod", name: "Production", slug: "prod", isDefault: true },
      { id: "e-sb", name: "Sandbox", slug: "sandbox", isDefault: false },
    ]),
  ),
];

const meta: Meta<typeof Workflows> = {
  title: "Screens/Workflows",
  component: Workflows,
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
type Story = StoryObj<typeof Workflows>;

/** The saved workflows with active toggles, versions, and per-workflow success rate. */
export const Populated: Story = {};

/** No workflows yet — the empty state. */
export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/graphs", () => HttpResponse.json([])),
        http.get("*/api/executions", () => HttpResponse.json([])),
        http.get("*/api/me", () =>
          HttpResponse.json({ userId: "u1", email: "a@b.co", tenantId: "t1" }),
        ),
      ],
    },
  },
};
