/**
 * Which workflows the MCP server actually exposes as their own tool, and what it calls them.
 *
 * This screen used to list a `run_<key>` row for EVERY saved workflow. The server exposes a
 * workflow only when it OPTS IN — `extractMcpServerTool` (apps/api/src/mcp/mcp-exposed.ts)
 * requires the graph's START node to be an `mcpServerTrigger`. So the panel advertised tools that
 * did not exist, and a user who connected a client saw only the six base tools and reasonably
 * concluded the MCP server was broken (#1063). Listing something that isn't there is worse than
 * listing nothing: it turns a working system into a suspected bug.
 *
 * `entryType` on the summary is the same fact the server keys on, so this filter cannot drift
 * from the server's rule without the summary itself being wrong.
 */

/** The entry-node type a workflow must have for the MCP server to expose it as a tool. */
export const MCP_TRIGGER_TYPE = "mcpServerTrigger";

/** Mirrors the server's `toolNamesFor` slugify (apps/api/src/mcp/mcp.server.ts). */
export function workflowToolName(workflowKey: string): string {
  return `run_${workflowKey.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/**
 * The per-workflow tool names this environment really exposes, in the order the panel shows them.
 *
 * NOTE the name is DERIVED: an `mcpServerTrigger` may configure its own `toolName`, which the
 * server prefers over `run_<key>`. That config isn't on the workflow summary, so a custom name
 * shows here as its derived form — the panel says so rather than pretending otherwise.
 */
export function exposedWorkflowTools(
  workflows: { workflowKey: string; entryType: string | null }[],
): string[] {
  return workflows
    .filter((w) => w.entryType === MCP_TRIGGER_TYPE)
    .map((w) => workflowToolName(w.workflowKey));
}
