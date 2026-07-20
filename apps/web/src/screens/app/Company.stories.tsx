import type { Meta, StoryObj } from "@storybook/react-vite";
import { delay, http, HttpResponse } from "msw";
import { ModeProvider } from "../../mode";
import { WorkspaceProvider } from "../../workspace/WorkspaceProvider";
import type {
  Company as CompanyModel,
  CompanyBudgetView,
  CompanyMember,
  CompanyUsage,
  Workspace,
} from "../../lib/api";
import { Company } from "./Company";

// WorkspaceProvider resolves these (GET /me/workspaces); the tenantIds match the usage
// rollup so the console's "Open" affordance shows for member workspaces.
const WORKSPACES = [
  { tenantId: "t1", role: "owner", name: "Acme Production" },
  { tenantId: "t2", role: "owner", name: "Acme Staging" },
] satisfies Workspace[];

const COMPANIES = [
  { id: "co-1", name: "Acme Inc.", slug: "acme", role: "owner" },
] satisfies CompanyModel[];

const USAGE = {
  range: { from: "2026-06-16T00:00:00.000Z", to: "2026-07-16T00:00:00.000Z" },
  totals: { costUsd: 184.42, totalTokens: 12_430_000, calls: 5820 },
  byWorkspace: [
    {
      tenantId: "t1",
      displayName: "Acme Production",
      costUsd: 142.1,
      totalTokens: 9_800_000,
      calls: 4310,
      archived: false,
      byEnvironment: [
        {
          environmentId: "e-prod",
          costUsd: 120.0,
          totalTokens: 8_100_000,
          calls: 3600,
        },
        {
          environmentId: "e-sb",
          costUsd: 22.1,
          totalTokens: 1_700_000,
          calls: 710,
        },
      ],
    },
    {
      tenantId: "t2",
      displayName: "Acme Staging",
      costUsd: 42.32,
      totalTokens: 2_630_000,
      calls: 1510,
      archived: false,
      byEnvironment: [
        {
          environmentId: null,
          costUsd: 42.32,
          totalTokens: 2_630_000,
          calls: 1510,
        },
      ],
    },
  ],
} satisfies CompanyUsage;

const BUDGET = {
  budget: { monthlyCapUsd: 500, onBudgetExceeded: "reject" },
  mtdSpendUsd: 184.42,
  remainingUsd: 315.58,
} satisfies CompanyBudgetView;

const MEMBERS = [
  { userId: "u1", email: "owner@acme.io", role: "owner" },
  { userId: "u2", email: "admin@acme.io", role: "admin" },
] satisfies CompanyMember[];

const baseHandlers = [
  http.get("*/api/me", () =>
    HttpResponse.json({ tenantId: "t1", subject: "u1" }),
  ),
  http.get("*/api/me/workspaces", () => HttpResponse.json(WORKSPACES)),
  http.get("*/api/me/companies", () => HttpResponse.json(COMPANIES)),
  http.get("*/api/companies/:id/usage", () => HttpResponse.json(USAGE)),
  http.get("*/api/companies/:id/budget", () => HttpResponse.json(BUDGET)),
  http.get("*/api/companies/:id/members", () => HttpResponse.json(MEMBERS)),
];

const meta: Meta<typeof Company> = {
  title: "Screens/Company",
  component: Company,
  parameters: { layout: "fullscreen", msw: { handlers: baseHandlers } },
  decorators: [
    (Story) => (
      <WorkspaceProvider>
        <ModeProvider>
          <div style={{ background: "var(--bg)", minHeight: "100vh" }}>
            <Story />
          </div>
        </ModeProvider>
      </WorkspaceProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof Company>;

/** The console: KPI stat band (with the pooled-budget gauge), the workspaces table,
 *  and the members card — all from the real rollup + budget. */
export const Populated: Story = {};

/** No company yet — the create-your-first empty state (getMyCompanies → []). */
export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/me/companies", () => HttpResponse.json([])),
        ...baseHandlers,
      ],
    },
  },
};

/** Companies resolved but the usage rollup is still loading — the console Spinner. */
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/companies/:id/usage", async () => {
          await delay("infinite");
          return HttpResponse.json(USAGE);
        }),
        ...baseHandlers,
      ],
    },
  },
};
