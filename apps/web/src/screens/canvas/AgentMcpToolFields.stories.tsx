/**
 * One in-loop MCP tool on an `agent` node.
 *
 * The same server listing serves a second purpose here. The agent node already had an
 * `inputSchema` field — hand-authored JSON that the worker falls back to an OPEN object for when
 * it's missing, meaning the model is left guessing argument names. The server knows them, so
 * "Fill from the server" copies them in.
 *
 * `FillFromServer`'s play function is the check that matters: it clicks the button and asserts the
 * stored config, so what's proved is that the schema LANDS in the node — not that a button exists.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import { AgentMcpToolFields } from "./McpToolFields";

const TOOLS = [
  {
    name: "search_issues",
    description: "Search a repository's issues.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
  },
  { name: "whoami", description: "Who the credential belongs to." },
];

// `tenantId`, not `id` — the workspace provider reads `tenantId`, and without it there is no
// active workspace and therefore no request at all.
const workspaces = http.get("*/api/me/workspaces", () =>
  HttpResponse.json([
    { tenantId: "t-demo", displayName: "Acme", role: "owner", archived: false },
  ]),
);
const ok = http.get("*/api/tenants/:id/connections/:cid/mcp/tools", () =>
  HttpResponse.json(TOOLS),
);

function Harness({
  tool,
  description = "",
  inputSchema,
}: {
  tool: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}) {
  const [row, setRow] = useState<Record<string, unknown>>({
    connectionId: "conn-agent",
    tool,
    name: "",
    description,
    inputSchema,
  });
  return (
    <div style={{ width: 400, padding: 16 }}>
      <AgentMcpToolFields
        connectionId="conn-agent"
        tool={(row.tool as string) ?? ""}
        name={(row.name as string) ?? ""}
        description={(row.description as string) ?? ""}
        inputSchema={row.inputSchema as Record<string, unknown> | undefined}
        onChange={(patch) => setRow((r) => ({ ...r, ...patch }))}
      />
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
        {JSON.stringify(row)}
      </div>
    </div>
  );
}

const meta: Meta<typeof Harness> = {
  title: "Canvas/AgentMcpToolFields",
  component: Harness,
  parameters: { msw: { handlers: [workspaces, ok] } },
};
export default meta;
type Story = StoryObj<typeof Harness>;

/** A tool picked from the server's list, with no schema authored yet. */
export const SchemaNotSet: Story = { args: { tool: "search_issues" } };

/** Clicking the fill button puts the server's real schema (and its description) on the node. */
export const FillFromServer: Story = {
  args: { tool: "search_issues" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const fill = await canvas.findByRole("button", {
      name: /Fill from the server/,
    });
    await userEvent.click(fill);
    await waitFor(() => {
      const stored = JSON.parse(
        canvas.getByTestId("stored").textContent ?? "{}",
      );
      // The names the model will now be told about — the reason the button exists.
      expect(Object.keys(stored.inputSchema.properties)).toEqual([
        "query",
        "limit",
      ]);
      expect(stored.description).toBe("Search a repository's issues.");
    });
  },
};

/** An author's own description survives the fill — their words win over the server's. */
export const FillKeepsAuthoredDescription: Story = {
  args: { tool: "search_issues", description: "Only OPEN issues, please." },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: /Fill from the server/ }),
    );
    await waitFor(() => {
      const stored = JSON.parse(
        canvas.getByTestId("stored").textContent ?? "{}",
      );
      expect(stored.description).toBe("Only OPEN issues, please.");
      expect(stored.inputSchema).toBeTruthy();
    });
  },
};

/** A tool the server ships without a schema: nothing to fill, so no button is offered. */
export const NothingToFill: Story = { args: { tool: "whoami" } };
