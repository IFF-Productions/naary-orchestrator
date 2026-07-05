import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { NODE_CATALOG } from "@naary/dsl";

/**
 * Per-session dependencies for the MCP tools. Bound to ONE tenant for the session's lifetime —
 * a tool never takes a tenantId argument (it comes only from the verified `nry_` token), which
 * keeps tenant isolation identical to the REST API (design §3 / CLAUDE.md Tier-1 rule 4).
 * Later slices add the executions/graphs/generator services here.
 */
export interface McpToolDeps {
  tenantId: string;
}

/** JSON payload → a text tool result (MCP's portable content shape). */
function jsonResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Build the naary control-plane MCP server for one session (design flavor A). Slice 1 exposes
 * the read-only `list_node_types` — how an external agent discovers what a workflow can be built
 * from (backed by the shared @naary/dsl catalog) before calling create_workflow in a later slice.
 */
export function buildMcpServer(_deps: McpToolDeps): McpServer {
  const server = new McpServer(
    { name: "naary-orchestrator", version: "0.1.0" },
    {
      instructions:
        "naary runs durable, long-running, human-in-the-loop workflows. Call list_node_types " +
        "to see the building blocks before creating a workflow.",
    },
  );

  server.tool(
    "list_node_types",
    "List every workflow node type available in naary — its group, a one-line summary, and a " +
      "hint of its key config. Use this to discover what a workflow can be built from.",
    async () =>
      jsonResult({
        nodes: Object.entries(NODE_CATALOG).map(([type, e]) => ({
          type,
          group: e.group,
          summary: e.summary,
          ...(e.config ? { config: e.config } : {}),
          ...(e.entry ? { entry: true } : {}),
        })),
      }),
  );

  return server;
}
