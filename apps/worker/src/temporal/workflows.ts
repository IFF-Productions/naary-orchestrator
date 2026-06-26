import * as wf from "@temporalio/workflow";
import { approvalSignal, stateQuery } from "@naary/contracts";
import type {
  ApprovalInput,
  ExecutionState,
  ExecutionStatus,
} from "@naary/contracts";
import { nextNodes, resolveMcpArguments } from "@naary/dsl";
import type { GraphDef, McpToolNodeConfig, NodeDef } from "@naary/dsl";
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
  /** The version-pinned graph snapshot this run executes (Slice #5). Carried in
   *  history for traceability; the interpreter walks the passed graph as-is. */
  graphContentHash?: string;
  graphVersion?: number;
  /** Force continueAsNew after this many steps (Slice #6) — deterministic, for
   *  long loops + tests. When unset, only Temporal's continueAsNewSuggested trips. */
  continueAsNewAfterSteps?: number;
}

/** Carried across continueAsNew so a long/looping run resumes with state intact
 *  (Slice #6) — the same graph snapshot is passed again as the first arg. */
export interface ResumeState {
  ctx: Record<string, unknown>;
  costUsd: number;
  stepCount: number;
  startNodeId: string;
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
  resume?: ResumeState,
): Promise<RunGraphResult> {
  // On a continueAsNew restart, seed state from the carried snapshot.
  const ctx: Record<string, unknown> = resume
    ? { ...resume.ctx }
    : { __input: input };
  let approval: ApprovalInput | undefined;
  let status: ExecutionStatus = "running";
  let currentNodeId = resume?.startNodeId ?? graph.startNodeId;

  // Deterministic enforcement state: driven ONLY by activity-returned costs and
  // a node counter — never a DB read in workflow code (CLAUDE.md rule 2; §3).
  let costUsd = resume?.costUsd ?? 0;
  let stepCount = resume?.stepCount ?? 0;

  wf.setHandler(approvalSignal, (s) => {
    approval = s;
  });
  wf.setHandler(
    stateQuery,
    (): ExecutionState => ({ status, currentNodeId, ctx }),
  );

  const nodeById = new Map<string, NodeDef>(graph.nodes.map((n) => [n.id, n]));

  /** Run one node's side effect. Returns a TERMINAL status to stop the whole run
   *  (rejected), or null to continue. Mutates ctx / cost via the closures. */
  async function execNode(node: NodeDef): Promise<ExecutionStatus | null> {
    switch (node.type) {
      case "start":
      case "end":
        return null;
      case "webhookTrigger":
        // Slice #4: the inbound event (the workflow input) is this node's output.
        ctx[node.id] = ctx.__input;
        return null;
      case "agent": {
        // tenantId flows in workflow args (not a secret); the activity fetches
        // the tenant's key by tenantId. executionId is deterministic.
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
        // Cost is a commutative SUM — accumulating it is order-independent (safe
        // even under parallel fan-out, where Temporal replays activity completion
        // order deterministically anyway).
        costUsd += result.costUsd;
        ctx.__costUsd = costUsd;
        return null;
      }
      case "mcpTool": {
        // Resolving tool args from upstream outputs is deterministic graph work,
        // so it happens HERE; the I/O (token fetch + HTTP) is inside the activity.
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
        return null;
      }
      case "humanApproval":
        status = "awaiting_approval";
        await wf.condition(() => approval !== undefined); // durable pause
        status = "running";
        if (!approval!.approved) return "rejected";
        approval = undefined; // consume so a later loop iteration can pause again
        return null;
    }
    return null;
  }

  /**
   * Execute a chain from `startId`: run a node, then follow the outgoing edges
   * whose condition passes (Slice #6). 0 next = chain ends; 1 = sequential/branch
   * (incl. a back-edge = loop); >1 = parallel fan-out via Promise.all (declared-
   * edge order; the first terminal in array order stops the whole run). Returns a
   * terminal status, or null when the chain completes normally.
   */
  async function execChain(
    startId: string,
    topLevel: boolean,
  ): Promise<ExecutionStatus | null> {
    let current: string | undefined = startId;
    while (current !== undefined) {
      // Circuit breaker + per-execution cap, before the node's work. The circuit
      // breaker now meaningfully bounds intentional LOOPS (closes QA#7).
      stepCount++;
      if (
        runCtx.maxStepsPerRun !== undefined &&
        stepCount > runCtx.maxStepsPerRun
      ) {
        return "circuit_open";
      }
      if (
        runCtx.perExecutionCapUsd !== undefined &&
        costUsd >= runCtx.perExecutionCapUsd
      ) {
        return "budget_exceeded";
      }

      const node = nodeById.get(current);
      if (node === undefined) {
        // Dangling edge / unknown node → terminal, not an infinite workflow-task
        // retry (QA#8). The control plane also validates before start.
        return "invalid_graph";
      }
      currentNodeId = current;

      const terminal = await execNode(node);
      if (terminal !== null) return terminal;

      const nexts = nextNodes(graph, current, ctx);
      if (nexts.length <= 1) {
        current = nexts[0]; // sequential / branch / loop back-edge (undefined = end)

        // Bound history growth on long loops (Slice #6): at a safe single-next
        // boundary in the top-level chain (no pending approval, no in-flight
        // handler), continueAsNew carrying the state so the run resumes intact.
        const cap = runCtx.continueAsNewAfterSteps;
        const shouldContinue =
          wf.workflowInfo().continueAsNewSuggested ||
          (cap !== undefined && stepCount >= cap);
        if (
          topLevel &&
          current !== undefined &&
          shouldContinue &&
          approval === undefined &&
          wf.allHandlersFinished()
        ) {
          await wf.continueAsNew<typeof runGraph>(graph, input, runCtx, {
            ctx,
            costUsd,
            stepCount,
            startNodeId: current,
          });
        }
      } else {
        // Parallel fan-out: each branch runs to its own terminal concurrently.
        // Cost/steps are commutative accumulations + Temporal replays activity
        // completion order deterministically, so the shared state stays
        // replay-safe. The per-exec cap can be overshot by a bounded amount across
        // concurrent branches (same class as the documented monthly-cap overshoot).
        // Branches are NOT top-level → they don't continueAsNew mid-flight.
        const results = await Promise.all(
          nexts.map((n) => execChain(n, false)),
        );
        for (const r of results) if (r !== null) return r; // array (edge) order
        return null;
      }
    }
    return null;
  }

  const terminal = await execChain(currentNodeId, true);
  status = terminal ?? "completed";
  return { status, ctx };
}
