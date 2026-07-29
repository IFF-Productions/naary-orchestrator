/**
 * The `mcpTool` node panel, whose tool name AND argument names both used to be free text.
 *
 * #915 gave the bindings editor a name dropdown wherever the set of names is knowable, and closed
 * only the `integration` node — an MCP tool's names are the SERVER's, and nothing asked it. These
 * stories exercise the asking: MSW serves `GET /api/tenants/:id/connections/:cid/mcp/tools`, so a
 * story renders through the real `useMcpTools` → `api.listMcpTools` path.
 *
 * `UnlistedTool` and `FetchFailed` are the ones to look at. A stored tool name outlives the
 * connection it was picked on, and a `<select>` whose value matches no `<option>` renders its
 * FIRST — so the panel would claim a different tool than the graph holds, and the next edit would
 * make that true. And a server we can't reach must degrade to the free text the node had before,
 * never to a wedged empty select.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import type { ConnectionRow } from "../../lib/api";
import type { BindingRow } from "./fields";
import { McpToolSection } from "./McpToolFields";

const CONNECTIONS = [
  {
    id: "conn-mcp",
    tenantId: "t-demo",
    type: "custom",
    label: "Acme MCP",
    serverUrl: "https://mcp.example.com/v1",
    authMode: "api_token",
    scopes: [],
    status: "connected",
    createdAt: new Date("2026-07-01T00:00:00Z").toISOString(),
  },
] as unknown as ConnectionRow[];

/** What the (mocked) server advertises — the API has already sanitized these. */
const TOOLS = [
  {
    name: "add_issue_comment",
    description: "Add a comment to an existing issue.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        issue_number: { type: "number" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "issue_number"],
    },
  },
  {
    name: "list_issues",
    description: "List a repository's issues.",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, state: { type: "string" } },
      required: ["owner"],
    },
  },
  // A tool the server ships with NO schema — its bindings must stay free text.
  { name: "whoami", description: "Who the credential belongs to." },
];

/**
 * The panel asks by TENANT id, which comes from `useWorkspace()` — and the preview's default
 * workspace handler answers with `id`, not the `tenantId` the provider reads. Without this the
 * active workspace is undefined, no request is ever made, and the story would silently "prove"
 * the offline path while looking like the online one.
 */
const workspaces = http.get("*/api/me/workspaces", () =>
  HttpResponse.json([
    { tenantId: "t-demo", displayName: "Acme", role: "owner", archived: false },
  ]),
);
const ok = http.get("*/api/tenants/:id/connections/:cid/mcp/tools", () =>
  HttpResponse.json(TOOLS),
);
const failing = http.get("*/api/tenants/:id/connections/:cid/mcp/tools", () =>
  HttpResponse.json(
    { message: "Could not list tools from 'Acme MCP'." },
    { status: 503 },
  ),
);

function Harness({
  tool,
  argumentBindings,
  connectionId = "conn-mcp",
}: {
  tool: string;
  argumentBindings?: Record<string, BindingRow>;
  connectionId?: string;
}) {
  const [config, setConfig] = useState<Record<string, unknown>>({
    connectionId,
    tool,
    argumentBindings,
  });
  return (
    <div style={{ width: 400, padding: 16 }}>
      <McpToolSection
        connections={CONNECTIONS}
        connectionId={(config.connectionId as string) ?? ""}
        tool={(config.tool as string) ?? ""}
        argumentBindings={
          config.argumentBindings as Record<string, BindingRow> | undefined
        }
        staticArguments={
          config.arguments as Record<string, unknown> | undefined
        }
        costUsd={config.costUsd as number | undefined}
        upstreamIds={["trigger", "analyze"]}
        onChange={(patch) => setConfig((c) => ({ ...c, ...patch }))}
      />
      {/* The STORED config beside the controls, so the check is that the value survives — not
          merely that something is on screen. */}
      <div
        data-testid="stored"
        style={{
          marginTop: 12,
          fontSize: 12,
          fontFamily: "ui-monospace, monospace",
          color: "var(--ink-3)",
          wordBreak: "break-all",
        }}
      >
        {JSON.stringify(config)}
      </div>
    </div>
  );
}

const meta: Meta<typeof Harness> = {
  title: "Canvas/McpToolSection",
  component: Harness,
  parameters: { msw: { handlers: [workspaces, ok] } },
};
export default meta;
type Story = StoryObj<typeof Harness>;

/** A tool the server offers: its own `inputSchema` names the arguments the bindings editor lists. */
export const ToolChosen: Story = {
  args: {
    tool: "add_issue_comment",
    argumentBindings: { owner: { from: "trigger", path: "body.owner" } },
  },
};

/** Nothing picked yet — the select offers the server's tools. */
export const NoToolYet: Story = { args: { tool: "" } };

/**
 * A tool name this server doesn't list (renamed upstream, or the connection was switched). It must
 * stay VISIBLE and stay SET — the whole reason the model is pure and tested.
 */
export const UnlistedTool: Story = {
  args: {
    tool: "close_incident",
    argumentBindings: { incident_id: { from: "analyze", path: "output.id" } },
  },
};

/** A tool the server ships with no schema: the name is picked, the arguments stay free text. */
export const ToolWithoutSchema: Story = { args: { tool: "whoami" } };

/**
 * The server is unreachable. Both controls fall back to the free text the node had before, and the
 * panel says why — an MCP server being down must never make a node uneditable.
 */
export const FetchFailed: Story = {
  parameters: { msw: { handlers: [workspaces, failing] } },
  args: { tool: "add_issue_comment", connectionId: "conn-offline" },
};

/** No connection chosen — there is nobody to ask, so free text with a nudge. */
export const NoConnection: Story = { args: { tool: "", connectionId: "" } };
