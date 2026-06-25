import { defineQuery, defineSignal } from "@temporalio/workflow";

/**
 * Execution protocol shared by the worker (workflow) and the api (client).
 * Client-safe: `defineSignal`/`defineQuery` are pure factories, so importing
 * this module in client code does NOT pull in workflow-sandbox runtime. (The
 * proxyActivities call that *is* sandbox-only lives in workflows.ts, not here.)
 */

export const TASK_QUEUE = "orchestrator";

/** Workflow type name — lets the client start runGraph by name if desired. */
export const RUN_GRAPH_WORKFLOW = "runGraph";

export type ExecutionStatus =
  | "running"
  | "awaiting_approval"
  | "completed"
  | "rejected";

export interface ExecutionState {
  status: ExecutionStatus;
  currentNodeId: string;
  ctx: Record<string, unknown>;
}

export interface ApprovalInput {
  approved: boolean;
}

/** Human approval: delivered as a Signal, awaited via condition() in the workflow. */
export const approvalSignal = defineSignal<[ApprovalInput]>("approval");

/** Live execution state, readable without disturbing the run. */
export const stateQuery = defineQuery<ExecutionState>("state");
