import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { setActiveEnvironment } from "../../lib/api";
import { Integrations } from "./Integrations";

const now = "2026-07-16T09:00:00Z";

const CONNECTIONS = [
  {
    id: "c1",
    type: "postgres",
    label: "prod-analytics",
    serverUrl: "analytics.db.internal:5432",
    authMode: "connection_string",
    scopes: [],
    status: "connected",
    usedByNodeCount: 3,
    createdAt: now,
  },
  {
    id: "c2",
    type: "postgres",
    label: "prod-billing",
    serverUrl: "billing.db.internal:5432",
    authMode: "connection_string",
    scopes: [],
    status: "connected",
    createdAt: now,
  },
  {
    id: "c3",
    type: "smtp",
    label: "transactional-email",
    serverUrl: "smtp.acme.com",
    authMode: "connection_string",
    scopes: [],
    status: "connected",
    createdAt: now,
  },
  {
    id: "c4",
    type: "signing",
    label: "webhook-signing",
    serverUrl: "webhook-signing",
    authMode: "api_token",
    scopes: [],
    status: "connected",
    credentialLast4: "a1b2",
    createdAt: now,
  },
  {
    id: "c5",
    type: "github",
    label: "acme-org",
    serverUrl: "https://github.com/acme",
    authMode: "github_app",
    scopes: ["repo", "issues", "checks"],
    status: "connected",
    usedByNodeCount: 1,
    credentialLast4: null, // github_app stores an installation grant, not a token → no last-4
    createdAt: now,
  },
  {
    id: "c6",
    type: "custom",
    label: "Weather MCP",
    serverUrl: "https://mcp.example.com",
    authMode: "oauth",
    scopes: ["tools:call"],
    status: "needs_reauth",
    usedByNodeCount: 0, // unused → safe to delete
    credentialLast4: null, // pre-consent OAuth → no stored token yet
    createdAt: now,
  },
];

const GRAPHS = [
  {
    workflowKey: "refund-triage",
    name: "Refund triage",
    version: 4,
    updatedAt: now,
    active: true,
    tags: [],
  },
  {
    workflowKey: "deal.won",
    name: "Deal won",
    version: 2,
    updatedAt: now,
    active: true,
    tags: [],
  },
  {
    workflowKey: "support-chat",
    name: "Support chat",
    version: 7,
    updatedAt: now,
    active: false,
    tags: [],
  },
];

const handlers = [
  http.get("*/api/me", () => HttpResponse.json({ tenantId: "t1" })),
  http.get("*/api/tenants/:t/connections", () =>
    HttpResponse.json(CONNECTIONS),
  ),
  http.get("*/api/tenants/:t/webhooks", () =>
    HttpResponse.json([
      {
        id: "w1",
        provider: "github",
        workflowId: "refund-triage",
        deliveries7d: 42,
        createdAt: now,
      },
      {
        id: "w2",
        provider: "generic",
        workflowId: "deal.won",
        deliveries7d: 0,
        createdAt: now,
      },
    ]),
  ),
  http.get("*/api/tenants/:t/forms", () =>
    HttpResponse.json([
      { id: "f1", workflowId: "lead-router", createdAt: now },
    ]),
  ),
  http.get("*/api/tenants/:t/chats", () =>
    HttpResponse.json([
      { id: "ch1", workflowId: "support-chat", createdAt: now },
    ]),
  ),
  http.get("*/api/tenants/:t/credentials", () =>
    HttpResponse.json([
      { provider: "anthropic", isValid: true },
      { provider: "openai", isValid: false },
      { provider: "claude-code", isValid: true },
    ]),
  ),
  http.get("*/api/tokens", () =>
    HttpResponse.json([
      {
        id: "t1",
        label: "CLI · laptop",
        createdAt: now,
        lastUsedAt: now,
        groupCount: 0,
      },
      {
        id: "t2",
        label: "CI pipeline",
        createdAt: now,
        lastUsedAt: null,
        groupCount: 1,
      },
    ]),
  ),
  http.get("*/api/graphs", () => HttpResponse.json(GRAPHS)),
];

const emptyHandlers = [
  http.get("*/api/me", () => HttpResponse.json({ tenantId: "t1" })),
  http.get("*/api/tenants/:t/connections", () => HttpResponse.json([])),
  http.get("*/api/tenants/:t/webhooks", () => HttpResponse.json([])),
  http.get("*/api/tenants/:t/forms", () => HttpResponse.json([])),
  http.get("*/api/tenants/:t/chats", () => HttpResponse.json([])),
  http.get("*/api/tenants/:t/credentials", () => HttpResponse.json([])),
  http.get("*/api/tokens", () => HttpResponse.json([])),
  http.get("*/api/graphs", () => HttpResponse.json([])),
];

const meta: Meta<typeof Integrations> = {
  title: "Screens/Integrations",
  component: Integrations,
  parameters: { layout: "fullscreen", msw: { handlers } },
  decorators: [
    (Story) => {
      // The shell normally publishes the active env; the screen's env chips echo it.
      setActiveEnvironment("prod");
      return (
        <div style={{ background: "var(--bg)", minHeight: "100vh" }}>
          <Story />
        </div>
      );
    },
  ],
};
export default meta;
type Story = StoryObj<typeof Integrations>;

/** Providers (BYOK): model-provider key slots + multi-connection SQL/SMTP/signing cards. */
export const Providers: Story = {
  parameters: {
    router: { initialEntries: ["/app/integrations?tab=providers"] },
  },
};

/** Webhooks: signed inbound endpoints + hosted public forms and chats. */
export const Webhooks: Story = {
  parameters: {
    router: { initialEntries: ["/app/integrations?tab=webhooks"] },
  },
};

/** MCP & API: always-on MCP server endpoint + exposed tools, and nry_ API tokens. */
export const McpAndApi: Story = {
  parameters: { router: { initialEntries: ["/app/integrations?tab=mcp"] } },
};

/** Apps & agents: GitHub App install, an MCP app needing re-auth, and the coding agent. */
export const AppsAndAgents: Story = {
  parameters: { router: { initialEntries: ["/app/integrations?tab=apps"] } },
};

/** First-run: nothing connected in this environment yet. */
export const Empty: Story = {
  parameters: {
    msw: { handlers: emptyHandlers },
    router: { initialEntries: ["/app/integrations?tab=providers"] },
  },
};
