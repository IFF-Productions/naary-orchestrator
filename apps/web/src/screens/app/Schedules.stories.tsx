import type { Meta, StoryObj } from "@storybook/react-vite";
import { delay, http, HttpResponse } from "msw";
import { Schedules } from "./Schedules";

// Fire times relative to "now" so the countdowns render meaningfully.
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const agoMs = (ms: number) => new Date(Date.now() - ms).toISOString();

/** Mixed active/paused rows. `hourly-lead-sync` has nextRunAt:null to exercise
 *  the client-side cron fallback; `invoice-reminders` is paused (dims + "— paused"). */
const SCHEDULES = [
  {
    id: "sch-1",
    workflowKey: "nightly-digest",
    cron: "0 6 * * *",
    paused: false,
    createdAt: agoMs(30 * 86400_000),
    nextRunAt: inMs(4 * 3600_000 + 12 * 60_000),
  },
  {
    id: "sch-2",
    workflowKey: "hourly-lead-sync",
    cron: "0 * * * *",
    paused: false,
    createdAt: agoMs(12 * 86400_000),
    nextRunAt: null, // → computed from the cron client-side
  },
  {
    id: "sch-3",
    workflowKey: "weekly-content-draft",
    cron: "0 9 * * 1",
    paused: false,
    createdAt: agoMs(60 * 86400_000),
    nextRunAt: inMs(2 * 86400_000),
  },
  {
    id: "sch-4",
    workflowKey: "warehouse-cleanup",
    cron: "0 3 * * 0",
    paused: false,
    createdAt: agoMs(90 * 86400_000),
    nextRunAt: inMs(3 * 86400_000 + 5 * 3600_000),
  },
  {
    id: "sch-5",
    workflowKey: "invoice-reminders",
    cron: "0 10 * * 1-5",
    paused: true,
    createdAt: agoMs(45 * 86400_000),
    nextRunAt: null,
  },
  {
    id: "sch-6",
    workflowKey: "uat-smoke-test",
    cron: "*/30 * * * *",
    paused: false,
    createdAt: agoMs(7 * 86400_000),
    nextRunAt: inMs(12 * 60_000),
  },
];

const GRAPHS = [
  ["nightly-digest", "Nightly digest"],
  ["hourly-lead-sync", "Hourly lead sync"],
  ["weekly-content-draft", "Weekly content draft"],
  ["warehouse-cleanup", "Data warehouse cleanup"],
  ["invoice-reminders", "Invoice reminders"],
  ["uat-smoke-test", "UAT smoke test"],
].map(([workflowKey, name], i) => ({
  workflowKey,
  name,
  version: i + 1,
  updatedAt: agoMs(86400_000),
  active: true,
  tags: [],
}));

/** Recent runs feeding the last-run column + the RUNS 24H stat. */
const RUNS = [
  {
    workflowId: "wh-1",
    workflowKey: "hourly-lead-sync",
    status: "completed",
    costUsd: 0.002,
    startedAt: agoMs(22 * 60_000),
    createdAt: agoMs(22 * 60_000),
    archived: false,
    graphVersion: 2,
  },
  {
    workflowId: "wh-2",
    workflowKey: "nightly-digest",
    status: "completed",
    costUsd: 0.014,
    startedAt: agoMs(20 * 3600_000),
    createdAt: agoMs(20 * 3600_000),
    archived: false,
    graphVersion: 1,
  },
  {
    workflowId: "wh-3",
    workflowKey: "warehouse-cleanup",
    status: "failed",
    costUsd: null,
    startedAt: agoMs(2 * 86400_000),
    createdAt: agoMs(2 * 86400_000),
    archived: false,
    graphVersion: 4,
  },
  {
    workflowId: "wh-4",
    workflowKey: "weekly-content-draft",
    status: "completed",
    costUsd: 0.09,
    startedAt: agoMs(5 * 86400_000),
    createdAt: agoMs(5 * 86400_000),
    archived: false,
    graphVersion: 3,
  },
  {
    workflowId: "wh-5",
    workflowKey: "uat-smoke-test",
    status: "running",
    costUsd: null,
    startedAt: agoMs(18 * 60_000),
    createdAt: agoMs(18 * 60_000),
    archived: false,
    graphVersion: 6,
  },
];

const ENVIRONMENTS = [
  { id: "e-sb", name: "sandbox", slug: "sandbox", isDefault: true },
  { id: "e-uat", name: "UAT", slug: "uat", isDefault: false },
  { id: "e-prod", name: "prod", slug: "prod", isDefault: false },
];

const baseHandlers = [
  http.get("*/api/me", () => HttpResponse.json({ tenantId: "t1" })),
  http.get("*/api/graphs", () => HttpResponse.json(GRAPHS)),
  http.get("*/api/executions", () => HttpResponse.json(RUNS)),
  http.get("*/api/tenants/:id/environments", () =>
    HttpResponse.json(ENVIRONMENTS),
  ),
];

const meta: Meta<typeof Schedules> = {
  title: "Screens/Schedules",
  component: Schedules,
  parameters: {
    layout: "fullscreen",
    msw: {
      handlers: [
        ...baseHandlers,
        http.get("*/api/tenants/:id/schedules", () =>
          HttpResponse.json(SCHEDULES),
        ),
        http.put("*/api/tenants/:id/schedules/:sid/pause", () =>
          HttpResponse.json({}),
        ),
        http.post("*/api/tenants/:id/schedules/:sid/trigger", () =>
          HttpResponse.json({}),
        ),
        http.delete("*/api/tenants/:id/schedules/:sid", () =>
          HttpResponse.json({}),
        ),
        http.post("*/api/tenants/:id/schedules", () =>
          HttpResponse.json(SCHEDULES[0]),
        ),
      ],
    },
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
type Story = StoryObj<typeof Schedules>;

/** Mixed active + paused rows: countdowns, cron fallback, last-run dots, dimmed paused row. */
export const Populated: Story = {};

/** No schedules yet — the teaching empty state with the create CTA. */
export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        ...baseHandlers,
        http.get("*/api/tenants/:id/schedules", () => HttpResponse.json([])),
      ],
    },
  },
};

/** Still loading — banner + table skeletons (response never resolves). */
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        ...baseHandlers,
        http.get("*/api/tenants/:id/schedules", async () => {
          await delay("infinite");
          return HttpResponse.json([]);
        }),
      ],
    },
  },
};
