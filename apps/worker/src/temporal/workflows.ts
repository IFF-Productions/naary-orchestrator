import * as wf from "@temporalio/workflow";
import { approvalSignal, stateQuery } from "@naary/contracts";
import type {
  ApprovalInput,
  ExecutionState,
  ExecutionStatus,
} from "@naary/contracts";
import { resolveMcpArguments, walk } from "@naary/dsl";
import type { GraphDef, McpToolNodeConfig } from "@naary/dsl";
// Type-only: keeps activity code OUT of the deterministic workflow bundle.
// Do NOT drop `type` — that would pull I/O code into the sandbox.
import type * as activities from "./activities";

const { runAgent, callMcpTool } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3 },
});

export interface RunGraphResult {
  status: ExecutionStatus;
  ctx: Record<string, unknown>;
}

/** Non-secret execution context. `tenantId` is fine in workflow args/history;
 *  the provider KEY is never here — it's fetched inside the activity by tenantId.
 *
 *  Budget caps are SNAPSHOTTED here at start (the api reads the tenant budget and
 *  passes them in) so enforcement stays deterministic — no DB read in the workflow.
 *  Enforcement is opt-in per cap: a cap that is undefined is not enforced. */
export interface RunGraphCtx {
  tenantId: string;
  perExecutionCapUsd?: number;
  maxStepsPerRun?: number;
}

/**
 * The generic interpreter: one workflow walks graph DATA (CLAUDE.md Tier-1
 * rule 1 — interpreter, not codegen). Deterministic — all side effects go
 * through activities; the human-approval pause is a Signal + condition(), never
 * a poll or sleep-loop (rules 2–5).
 */
export async function runGraph(
  graph: GraphDef,
  input: unknown,
  runCtx: RunGraphCtx,
): Promise<RunGraphResult> {
  const ctx: Record<string, unknown> = { __input: input };
  let approval: ApprovalInput | undefined;
  let status: ExecutionStatus = "running";
  let currentNodeId = graph.startNodeId;

  // Deterministic enforcement state: driven ONLY by activity-returned costs and
  // a node counter — never a DB read in workflow code (CLAUDE.md rule 2; §3).
  let costUsd = 0;
  let stepCount = 0;

  wf.setHandler(approvalSignal, (s) => {
    approval = s;
  });
  wf.setHandler(
    stateQuery,
    (): ExecutionState => ({ status, currentNodeId, ctx }),
  );

  for (const node of walk(graph)) {
    currentNodeId = node.id;

    // Circuit breaker + per-execution cap, checked before doing this node's work
    // (so accumulated cost from prior agent nodes halts the next one cleanly).
    stepCount++;
    if (
      runCtx.maxStepsPerRun !== undefined &&
      stepCount > runCtx.maxStepsPerRun
    ) {
      status = "circuit_open";
      return { status, ctx };
    }
    if (
      runCtx.perExecutionCapUsd !== undefined &&
      costUsd >= runCtx.perExecutionCapUsd
    ) {
      status = "budget_exceeded";
      return { status, ctx };
    }

    switch (node.type) {
      case "start":
      case "end":
        break;
      case "webhookTrigger":
        // Slice #4: the inbound event (the workflow input) is this node's output.
        // Pure — no I/O; determinism boundary stays clean.
        ctx[node.id] = ctx.__input;
        break;
      case "agent": {
        // tenantId flows in workflow args (not a secret); the activity fetches
        // the tenant's key by tenantId. executionId comes from workflowInfo
        // (deterministic, workflow-safe — no I/O).
        const result = await runAgent(
          node.config as unknown as activities.AgentConfig,
          ctx.__input,
          {
            tenantId: runCtx.tenantId,
            executionId: wf.workflowInfo().workflowId,
            nodeId: node.id,
          },
        );
        ctx[node.id] = result;
        // Accumulate the cost the activity RETURNED — deterministic.
        costUsd += result.costUsd;
        ctx.__costUsd = costUsd;
        break;
      }
      case "mcpTool": {
        // Calls a remote MCP server tool via a connection. Resolving the tool
        // arguments from upstream node outputs is deterministic graph-traversal
        // work, so it happens HERE (not in the activity). Token fetch + the HTTP
        // call are I/O inside the activity; the workflow passes tenantId + the
        // resolved arguments. No cost (counts toward stepCount only).
        const mcpCfg = node.config as unknown as McpToolNodeConfig;
        ctx[node.id] = await callMcpTool(
          {
            connectionId: mcpCfg.connectionId,
            tool: mcpCfg.tool,
            arguments: resolveMcpArguments(mcpCfg, ctx),
          },
          ctx.__input,
          {
            tenantId: runCtx.tenantId,
            executionId: wf.workflowInfo().workflowId,
            nodeId: node.id,
          },
        );
        break;
      }
      case "humanApproval":
        status = "awaiting_approval";
        await wf.condition(() => approval !== undefined); // durable pause
        status = "running";
        if (!approval!.approved) {
          status = "rejected";
          return { status, ctx };
        }
        break;
    }
  }

  status = "completed";
  return { status, ctx };
}
