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
/** Result of create_workflow — the draft, plus save fields when persisted. */
export interface McpCreateWorkflowResult {
  name: string;
  graph: unknown;
  saved: boolean;
  workflowKey?: string;
  version?: number;
  contentHash?: string;
}

export interface McpCreateWorkflowArgs {
  prompt?: string;
  name?: string;
  graph?: Record<string, unknown>;
  save?: boolean;
  workflowKey?: string;
}

export interface McpToolDeps {
  tenantId: string;
  listWorkflows: () => Promise<McpWorkflowSummary[]>;
  getRun: (runId: string) => Promise<McpRunState>;
  runWorkflow: (
    workflowKey: string,
    input?: Record<string, unknown>,
  ) => Promise<{ runId: string }>;
  createWorkflow: (
    args: McpCreateWorkflowArgs,
  ) => Promise<McpCreateWorkflowResult>;
  approve: (runId: string, approved: boolean, note?: string) => Promise<void>;
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
 *   - create_workflow — draft a graph from a prompt (or accept one) and optionally save it
 *   - run_workflow    — start a durable run of a saved workflow
 *   - get_run         — a run's status + node outputs
 *   - approve         — resolve a run paused on a human-approval step
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
    "create_workflow",
    "Create a workflow — two ways: pass `prompt` (plain English → the AI builder drafts a " +
      "graph) OR pass a `graph` you authored (with `name`). By default returns the DRAFT " +
      "WITHOUT saving (saved:false) so you can inspect it; pass save:true to persist it and get " +
      "a workflowKey you can run_workflow. Call list_node_types first to know the node vocabulary.",
    {
      prompt: z
        .string()
        .optional()
        .describe(
          "Plain-English description; the AI builder drafts the graph.",
        ),
      name: z
        .string()
        .optional()
        .describe(
          "Workflow name (used with a supplied graph, or to name a saved one).",
        ),
      graph: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("A graph you authored: { nodes, edges, startNodeId }."),
      save: z
        .boolean()
        .optional()
        .describe(
          "Persist the workflow (default false = return a draft only).",
        ),
      workflowKey: z
        .string()
        .optional()
        .describe("Key to save under (default: derived from the name)."),
    },
    async (args) => jsonResult(await deps.createWorkflow(args)),
  );

  server.tool(
    "run_workflow",
    "Start a durable run of a saved workflow by its workflowKey (from list_workflows), with an " +
      "optional JSON input passed to the trigger node. Returns { runId } immediately — the run " +
      "keeps executing even after you disconnect (it can take minutes or days, e.g. awaiting a " +
      "human approval). Poll get_run with the returned runId to await its result.",
    {
      workflowKey: z
        .string()
        .describe("The workflow to run (a key from list_workflows)."),
      input: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Optional JSON input for the trigger node."),
    },
    async ({ workflowKey, input }) =>
      jsonResult(await deps.runWorkflow(workflowKey, input)),
  );

  server.tool(
    "get_run",
    "Get the current status and node outputs of a workflow run by its runId. Runs are durable " +
      "and may be pending for minutes or days (e.g. awaiting a human approval) — poll this to " +
      "await completion. `ctx` maps each node id to its output.",
    { runId: z.string().describe("The run id returned by run_workflow.") },
    async ({ runId }) => jsonResult(await deps.getRun(runId)),
  );

  server.tool(
    "approve",
    "Resolve a run that is paused on a human-approval step (status awaiting_approval): approve " +
      "it to continue, or reject it to stop the run. Find such runs via get_run — this is how an " +
      "agent satisfies (or a human in the UI satisfies) a durable approval gate.",
    {
      runId: z.string().describe("The paused run's id."),
      decision: z
        .enum(["approve", "reject"])
        .describe("approve → continue the run; reject → stop it."),
      note: z
        .string()
        .optional()
        .describe("Optional note recorded with the decision."),
    },
    async ({ runId, decision, note }) => {
      await deps.approve(runId, decision === "approve", note);
      return jsonResult({ runId, decision, ok: true });
    },
  );

  return server;
}
