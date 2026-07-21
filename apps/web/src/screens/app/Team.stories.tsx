import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { Team } from "./Team";

/** Relative "last active" fixture — minutes ago from render time, so the story shows the
 *  live "5m/2h/1d ago" buckets rather than stale absolute dates (#489). */
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/** RBAC U1 member rows: active memberships ∪ pending invitations. */
const MEMBERS = [
  {
    id: "u-maria",
    userId: "u-maria",
    email: "maria.alvarez@northwind.io",
    role: "owner",
    status: "active",
    createdAt: "2026-01-12T09:00:00Z",
    lastActiveAt: minsAgo(3), // "3m ago"
  },
  {
    id: "u-james",
    userId: "u-james",
    email: "james.park@northwind.io",
    role: "admin",
    status: "active",
    createdAt: "2026-02-03T09:00:00Z",
    lastActiveAt: minsAgo(95), // "1h ago"
  },
  {
    id: "u-sam",
    userId: "u-sam",
    email: "sam.rivera@acme.io",
    role: "member",
    status: "active",
    createdAt: "2026-03-19T09:00:00Z",
    lastActiveAt: minsAgo(60 * 26), // "1d ago"
  },
  {
    id: "u-ada",
    userId: "u-ada",
    email: "ada.lopez@northwind.io",
    role: "member",
    status: "active",
    createdAt: "2026-05-02T09:00:00Z",
    lastActiveAt: "2026-04-30T09:00:00Z", // old → absolute date
  },
  {
    id: "u-dana",
    userId: "u-dana",
    email: "dana.cho@northwind.io",
    role: "member",
    status: "active",
    createdAt: "2026-06-21T09:00:00Z",
    lastActiveAt: null, // "Never" — invited-then-joined but not yet seen since tracking
  },
  {
    id: "inv-1",
    email: "rob@northwind.io",
    role: "member",
    status: "invited",
    createdAt: "2026-07-14T09:00:00Z",
  },
  {
    id: "inv-2",
    email: "priya@northwind.io",
    role: "admin",
    status: "invited",
    createdAt: "2026-07-16T09:00:00Z",
  },
];

const grant = (over: Record<string, unknown>) => ({
  id: `gr-${Math.random().toString(36).slice(2, 8)}`,
  environmentId: null,
  scope: "all",
  canView: true,
  canRun: false,
  canEdit: false,
  canDelete: false,
  canShare: false,
  canCreate: false,
  workflowKeys: [],
  tagIds: [],
  ...over,
});

/** Restricted workspace: Ops grants Run on everything (sam → any gate); Finance
 *  approvers grants Run on selected workflows (ada); dana is in no group. */
const GROUPS_RESTRICTED = [
  {
    id: "g-ops",
    name: "Ops",
    createdAt: "2026-04-01T09:00:00Z",
    members: [{ userId: "u-sam", createdAt: "2026-04-01T09:00:00Z" }],
    tokens: [],
    grants: [grant({ canRun: true, canEdit: true })],
  },
  {
    id: "g-fin",
    name: "Finance approvers",
    createdAt: "2026-04-10T09:00:00Z",
    members: [{ userId: "u-ada", createdAt: "2026-04-10T09:00:00Z" }],
    tokens: [],
    grants: [
      grant({
        canRun: true,
        scope: "selected",
        workflowKeys: ["refund-approver", "invoice-review"],
      }),
    ],
  },
  {
    id: "g-view",
    name: "Read-only auditors",
    createdAt: "2026-05-15T09:00:00Z",
    members: [],
    tokens: [],
    grants: [grant({})],
  },
];

const base = (groups: "forbidden" | Record<string, unknown>[]) => [
  http.get("*/api/me", () => HttpResponse.json({ tenantId: "t1" })),
  http.get("*/api/me/workspaces", () =>
    HttpResponse.json([{ tenantId: "t1", role: "owner", name: "Northwind" }]),
  ),
  http.get("*/api/tenants/:t/members", () => HttpResponse.json(MEMBERS)),
  http.get("*/api/tenants/:t/groups", () =>
    groups === "forbidden"
      ? new HttpResponse(null, { status: 403 })
      : HttpResponse.json(groups),
  ),
];

const meta: Meta<typeof Team> = {
  title: "Screens/Team",
  component: Team,
  parameters: {
    layout: "fullscreen",
    msw: { handlers: base(GROUPS_RESTRICTED) },
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
type Story = StoryObj<typeof Team>;

/** Members table in a RESTRICTED workspace (grants exist): owner/admin bypass →
 *  "Any gate"; sam via Ops (Run on all); ada via Finance approvers (selected);
 *  dana in no group → "None". Two pending invites as footer rows. */
export const Members: Story = {};

/** Unrestricted workspace (zero grants — the pre-cliff default): every member
 *  can approve any gate, and the legend/pending rows still render. */
export const MembersUnrestricted: Story = {
  parameters: { msw: { handlers: base([]) } },
};

/** Roles & access: real owner/admin/member capability cards (approval caps teal)
 *  + the Permission-groups summary card linking to /app/groups. */
export const RolesAndAccess: Story = {
  args: { initialTab: "roles" },
};

/** A plain member's view: GET /groups 403s (owner/admin-only), so per-member
 *  verdicts fall back to the stated rule ("run access = approve access") and the
 *  groups card explains instead of listing. */
export const AsMemberGroupsHidden: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/me", () => HttpResponse.json({ tenantId: "t1" })),
        http.get("*/api/me/workspaces", () =>
          HttpResponse.json([
            { tenantId: "t1", role: "member", name: "Northwind" },
          ]),
        ),
        http.get("*/api/tenants/:t/members", () => HttpResponse.json(MEMBERS)),
        http.get(
          "*/api/tenants/:t/groups",
          () => new HttpResponse(null, { status: 403 }),
        ),
      ],
    },
  },
};
