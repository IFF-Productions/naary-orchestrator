import type { Meta, StoryObj } from "@storybook/react-vite";
import { delay, http, HttpResponse } from "msw";
import { ModeProvider } from "../../mode";
import type { CompanyGroup, CompanyMember } from "../../lib/api";
import { CompanyGroupsCard } from "./CompanyGroups";

const MEMBERS = [
  { userId: "u1", email: "owner@acme.io", role: "owner" },
  { userId: "u2", email: "admin@acme.io", role: "admin" },
  { userId: "u3", email: "lead@acme.io", role: "admin" },
] satisfies CompanyMember[];

// v1 company groups: a SINGLE all-workflows grant per group. Give at least one a non-null
// grant so the six-verb matrix shows toggles on.
const GROUPS = [
  {
    id: "cg-ops",
    name: "Cross-workspace Ops",
    createdAt: "2026-06-01T10:00:00.000Z",
    members: [
      { userId: "u1", createdAt: "2026-06-01T10:00:00.000Z" },
      { userId: "u2", createdAt: "2026-06-02T10:00:00.000Z" },
    ],
    grant: {
      id: "cgg-1",
      canView: true,
      canRun: true,
      canEdit: true,
      canDelete: false,
      canShare: true,
      canCreate: false,
      createdAt: "2026-06-01T10:00:00.000Z",
    },
  },
  {
    id: "cg-viewers",
    name: "Auditors",
    createdAt: "2026-06-05T10:00:00.000Z",
    members: [{ userId: "u3", createdAt: "2026-06-05T10:00:00.000Z" }],
    grant: null,
  },
] satisfies CompanyGroup[];

const baseHandlers = [
  http.get("*/api/companies/:id/groups", () => HttpResponse.json(GROUPS)),
  http.get("*/api/companies/:id/members", () => HttpResponse.json(MEMBERS)),
];

const meta: Meta<typeof CompanyGroupsCard> = {
  title: "Screens/CompanyGroups",
  component: CompanyGroupsCard,
  args: { companyId: "co-1" },
  parameters: { layout: "fullscreen", msw: { handlers: baseHandlers } },
  decorators: [
    (Story) => (
      <ModeProvider>
        <div
          style={{
            background: "var(--bg)",
            minHeight: "100vh",
            padding: "22px 28px",
            maxWidth: 1080,
          }}
        >
          <Story />
        </div>
      </ModeProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof CompanyGroupsCard>;

/** The owner-only company-groups card: rail + the selected group's single all-workflows
 *  grant matrix (verbs on), Applies-to pill, and the company-member list. */
export const Populated: Story = {};

/** No company groups yet — the rail's "create one below" hint. */
export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/companies/:id/groups", () => HttpResponse.json([])),
        ...baseHandlers,
      ],
    },
  },
};

/** Still loading the groups — the card Spinner (response never resolves). */
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/companies/:id/groups", async () => {
          await delay("infinite");
          return HttpResponse.json([]);
        }),
        ...baseHandlers,
      ],
    },
  },
};
