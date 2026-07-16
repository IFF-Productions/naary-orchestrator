import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { Integrations } from "./Integrations";

const now = "2026-07-16T09:00:00Z";

const handlers = [
  http.get("*/api/me", () => HttpResponse.json({ tenantId: "t1" })),
  http.get("*/api/tenants/:t/connections", () =>
    HttpResponse.json([
      {
        id: "c1",
        type: "github",
        label: "acme-org",
        serverUrl: "https://github.com/acme",
        authMode: "github_app",
        scopes: ["repo", "issues"],
        status: "connected",
        createdAt: now,
      },
      {
        id: "c2",
        type: "custom",
        label: "Weather MCP",
        serverUrl: "https://mcp.example.com",
        authMode: "api_token",
        scopes: [],
        status: "needs_reauth",
        createdAt: now,
      },
    ]),
  ),
  http.get("*/api/tenants/:t/webhooks", () =>
    HttpResponse.json([
      {
        id: "w1",
        provider: "github",
        workflowId: "refund-triage",
        createdAt: now,
      },
    ]),
  ),
  http.get("*/api/tenants/:t/forms", () =>
    HttpResponse.json([
      { id: "f1", workflowId: "lead-router", createdAt: now },
    ]),
  ),
  http.get("*/api/tenants/:t/chats", () => HttpResponse.json([])),
  http.get("*/api/tenants/:t/credentials", () =>
    HttpResponse.json([
      { provider: "anthropic", isValid: true },
      { provider: "openai", isValid: false },
    ]),
  ),
  http.get("*/api/tokens", () =>
    HttpResponse.json([
      { id: "t1", label: "CI deploy", createdAt: now, lastUsedAt: now },
    ]),
  ),
];

const meta: Meta<typeof Integrations> = {
  title: "Screens/Integrations",
  component: Integrations,
  parameters: { layout: "fullscreen", msw: { handlers } },
  decorators: [
    (Story) => (
      <div style={{ background: "var(--bg)", minHeight: "100vh" }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof Integrations>;

/** Connections (GitHub connected, an MCP needing re-auth), webhooks, forms, provider keys, tokens. */
export const Default: Story = {};
