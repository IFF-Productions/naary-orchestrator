import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { NODE_CATALOG } from "@naary/dsl";
import { z } from "zod";

/**
 * A saved workflow, as the agent sees it. */
export interface McpWorkflowSummary {
  workflowKey: string;
  name: string;
  version: number;
  updatedAt?: string;
}

/** A run's state, as the agent sees it. `ctx` holds each node's output keyed by node id. */
export interface McpRunState {
  status: string;
  currentNodeId?: string;
  ctx: Record<string, unknown>;
}

/**
 * Per-session dependencies for the MCP tools. Bound to ONE tenant for the session's lifetime —
 * the tenant scope lives in these already-bound closures, never in a tool argument, which keeps
 * isolation identical to the REST API (design §3 / CLAUDE.md Tier-1 rule 4). The controller
 * wires these to GraphsService/ExecutionsService (both pre-scoped to the token's tenantId).
 */
export interface McpToolDeps {
  tenantId: string;
  listWorkflows: () => Promise<McpWorkflowSummary[]>;
  getRun: (runId: string) => Promise<McpRunState>;
}

/** JSON payload → a text tool result (MCP's portable content shape). */
function jsonResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Build the naary control-plane MCP server for one session (design flavor A). Tools so far:
 *   - list_node_types — discover the building blocks (shared @naary/dsl catalog)
 *   - list_workflows  — the tenant's saved workflows
 *   - get_run         — a run's status + node outputs
 * (create_workflow / run_workflow / approve land in later slices.)
 */
export function buildMcpServer(deps: McpToolDeps): McpServer {
  const server = new McpServer(
    { name: "naary-orchestrator", version: "0.1.0" },
    {
      instructions:
        "naary runs durable, long-running, human-in-the-loop workflows. Call list_node_types " +
        "to see the building blocks, list_workflows to see what's saved, and get_run to check " +
        "on a run (it can be pending for minutes or days — poll get_run).",
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

  server.tool(
    "list_workflows",
    "List the saved workflows in this workspace (one entry per workflow, its latest version). " +
      "Use a returned workflowKey with run_workflow (later) or to reference an existing flow.",
    async () => jsonResult({ workflows: await deps.listWorkflows() }),
  );

  server.tool(
    "get_run",
    "Get the current status and node outputs of a workflow run by its runId. Runs are durable " +
      "and may be pending for minutes or days (e.g. awaiting a human approval) — poll this to " +
      "await completion. `ctx` maps each node id to its output.",
    { runId: z.string().describe("The run id returned by run_workflow.") },
    async ({ runId }) => jsonResult(await deps.getRun(runId)),
  );

  return server;
}
