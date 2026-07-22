/**
 * Pure (no NestJS / no I/O) opt-in detection for the MCP Server-Trigger node
 * (docs/design/MCP-SERVER.md §5, flavor B). Mirrors `forms/form-definition.ts`'s
 * `extractFormDefinition`: a workflow opts in to being hosted as an MCP tool by having its
 * ENTRY node (the graph's `startNodeId`) be an `mcpServerTrigger` — matched on the ENTRY node
 * ONLY, never "contains one anywhere", so a graph later re-pointed at a different entry stops
 * being exposed. Unit-tested in test/mcp-exposed.spec.ts.
 */
import type { GraphDef } from "@naary/dsl";

/** The MCP tool config an opted-in workflow advertises, read from its `mcpServerTrigger` entry
 *  node. Both fields are optional — an un-configured node still opts in (the server derives a
 *  `run_<workflowKey>` name + a generic description). */
export interface McpServerToolConfig {
  toolName?: string;
  toolDescription?: string;
}

/**
 * If `graph`'s ENTRY node is an `mcpServerTrigger`, return the tool config read from it (a bare
 * `{}` when unconfigured); otherwise return `null` (the workflow is NOT exposed as its own MCP
 * tool). Non-string / blank config values are ignored so nothing unexpected rides out as a tool
 * name/description.
 */
export function extractMcpServerTool(
  graph: GraphDef,
): McpServerToolConfig | null {
  const entry = graph.nodes?.find((n) => n.id === graph.startNodeId);
  if (!entry || entry.type !== "mcpServerTrigger") return null;
  const cfg = (entry.config ?? {}) as {
    toolName?: unknown;
    description?: unknown;
  };
  const out: McpServerToolConfig = {};
  if (typeof cfg.toolName === "string" && cfg.toolName.trim()) {
    out.toolName = cfg.toolName;
  }
  if (typeof cfg.description === "string" && cfg.description.trim()) {
    out.toolDescription = cfg.description;
  }
  return out;
}
