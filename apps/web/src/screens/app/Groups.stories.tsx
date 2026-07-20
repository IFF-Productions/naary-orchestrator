import type { Meta, StoryObj } from "@storybook/react-vite";
import { delay, http, HttpResponse } from "msw";
import { ModeProvider } from "../../mode";
import type {
  ApiTokenRow,
  Environment,
  GraphSummary,
  Member,
  PermissionGroup,
  Tag,
} from "../../lib/api";
import { Groups } from "./Groups";

// Owner in tenant "t1" → the editable matrix (member/admin get the read-only view).
const WORKSPACES = [
  { tenantId: "t1", role: "owner", name: "Acme Corp" },
  { tenantId: "t2", role: "member", name: "Side Project" },
];

const ENVIRONMENTS = [
  { id: "e-sb", name: "sandbox", slug: "sandbox", isDefault: true },
  { id: "e-uat", name: "UAT", slug: "uat", isDefault: false },
  { id: "e-prod", name: "prod", slug: "prod", isDefault: false },
] satisfies Environment[];

// Active members + one pending invitation (Groups drops non-active rows).
const MEMBERS = [
  {
    id: "u1",
    userId: "u1",
    email: "ada@acme.io",
    role: "admin",
    status: "active",
    createdAt: "2026-06-01T10:00:00.000Z",
  },
  {
    id: "u2",
    userId: "u2",
    email: "grace@acme.io",
    role: "member",
    status: "active",
    createdAt: "2026-06-02T10:00:00.000Z",
  },
  {
    id: "inv-1",
    email: "pending@acme.io",
    role: "member",
    status: "invited",
    createdAt: "2026-07-10T10:00:00.000Z",
  },
] satisfies Member[];

const TOKENS = [
  {
    id: "tok-ci",
    label: "CI deploy",
    createdAt: "2026-06-01T10:00:00.000Z",
    lastUsedAt: "2026-07-15T09:00:00.000Z",
    groupCount: 1,
  },
  {
    id: "tok-mcp",
    label: "MCP server",
    createdAt: "2026-06-10T10:00:00.000Z",
    lastUsedAt: null,
    groupCount: 0,
  },
] satisfies ApiTokenRow[];

// Groups that HAVE grants → the verb matrix renders (all-scope + a selected/per-env grant).
const GROUPS = [
  {
    id: "g-ops",
    name: "Ops",
    createdAt: "2026-06-01T10:00:00.000Z",
    members: [{ userId: "u1", createdAt: "2026-06-01T10:00:00.000Z" }],
    tokens: [{ tokenId: "tok-ci", createdAt: "2026-06-01T10:00:00.000Z" }],
    grants: [
      {
        id: "gr-1",
        environmentId: null,
        scope: "all",
        canView: true,
        canRun: true,
        canEdit: false,
        canDelete: false,
        canShare: false,
        canCreate: false,
        workflowKeys: [],
        tagIds: [],
      },
      {
        id: "gr-2",
        environmentId: "e-prod",
        scope: "selected",
        canView: true,
        canRun: true,
        canEdit: true,
        canDelete: false,
        canShare: true,
        canCreate: false,
        workflowKeys: ["refund-triage"],
        tagIds: ["tag-billing"],
      },
    ],
  },
  {
    id: "g-viewers",
    name: "Viewers",
    createdAt: "2026-06-03T10:00:00.000Z",
    members: [{ userId: "u2", createdAt: "2026-06-03T10:00:00.000Z" }],
    tokens: [],
    grants: [
      {
        id: "gr-3",
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
      },
    ],
  },
] satisfies PermissionGroup[];

const GRAPHS = [
  {
    workflowKey: "refund-triage",
    name: "Refund triage",
    version: 3,
    updatedAt: "2026-07-15T09:00:00.000Z",
    active: true,
    tags: [{ id: "tag-billing", name: "billing", color: "#4a9dff" }],
  },
  {
    workflowKey: "invoice-sync",
    name: "Invoice sync",
    version: 7,
    updatedAt: "2026-07-14T09:00:00.000Z",
    active: false,
    tags: [],
  },
] satisfies GraphSummary[];

const TAGS = [
  { id: "tag-billing", name: "billing", color: "#4a9dff", workflowCount: 1 },
  { id: "tag-ops", name: "ops", color: "#c07bff", workflowCount: 0 },
] satisfies Tag[];

const baseHandlers = [
  http.get("*/api/me", () =>
    HttpResponse.json({ tenantId: "t1", subject: "u1" }),
  ),
  http.get("*/api/me/workspaces", () => HttpResponse.json(WORKSPACES)),
  http.get("*/api/tenants/:t/groups", () => HttpResponse.json(GROUPS)),
  http.get("*/api/tenants/:t/members", () => HttpResponse.json(MEMBERS)),
  http.get("*/api/tokens", () => HttpResponse.json(TOKENS)),
  http.get("*/api/tenants/:t/environments", () =>
    HttpResponse.json(ENVIRONMENTS),
  ),
  http.get("*/api/graphs", () => HttpResponse.json(GRAPHS)),
  http.get("*/api/tags", () => HttpResponse.json(TAGS)),
];

const meta: Meta<typeof Groups> = {
  title: "Screens/Groups",
  component: Groups,
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
type Story = StoryObj<typeof Groups>;

/** Owner view: the two-pane group rail + the selected group's six-verb grant matrix,
 *  with members, attached tokens, and the deny-by-default (enforcement on) banner. */
export const Populated: Story = {};

/** No permission groups yet — the teaching empty state (implicit-allow). */
export const Empty: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/tenants/:t/groups", () => HttpResponse.json([])),
        ...baseHandlers,
      ],
    },
  },
};

/** Still loading the group list — the LoadingBlock (response never resolves). */
export const Loading: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/tenants/:t/groups", async () => {
          await delay("infinite");
          return HttpResponse.json([]);
        }),
        ...baseHandlers,
      ],
    },
  },
};

/** Unauthenticated (getMe 401) — the "Sign in to manage permission groups." error. */
export const Unauthorized: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get("*/api/me", () => new HttpResponse(null, { status: 401 })),
        ...baseHandlers,
      ],
    },
  },
};
