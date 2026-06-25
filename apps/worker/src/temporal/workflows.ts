import * as wf from "@temporalio/workflow";
import { approvalSignal, stateQuery } from "@naary/contracts";
import type {
  ApprovalInput,
  ExecutionState,
  ExecutionStatus,
} from "@naary/contracts";
import { walk } from "@naary/dsl";
import type { GraphDef } from "@naary/dsl";
// Type-only: keeps activity code OUT of the deterministic workflow bundle.
// Do NOT drop `type` — that would pull I/O code into the sandbox.
import type * as activities from "./activities";

const { runAgentStub } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3 },
});

export interface RunGraphResult {
  status: ExecutionStatus;
  ctx: Record<string, unknown>;
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
): Promise<RunGraphResult> {
  const ctx: Record<string, unknown> = { __input: input };
  let approval: ApprovalInput | undefined;
  let status: ExecutionStatus = "running";
  let currentNodeId = graph.startNodeId;

  wf.setHandler(approvalSignal, (s) => {
    approval = s;
  });
  wf.setHandler(
    stateQuery,
    (): ExecutionState => ({ status, currentNodeId, ctx }),
  );

  for (const node of walk(graph)) {
    currentNodeId = node.id;
    switch (node.type) {
      case "start":
      case "end":
        break;
      case "agent":
        ctx[node.id] = await runAgentStub(
          node.config as { canned: string },
          ctx.__input,
        );
        break;
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
