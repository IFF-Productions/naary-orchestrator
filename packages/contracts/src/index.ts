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
  | "rejected"
  | "awaiting_webhook" // paused on a wait(webhook) node until an external resume call
  | "budget_exceeded" // per-execution cost cap hit (Slice #3)
  | "circuit_open" // max-step circuit breaker tripped (Slice #3)
  | "invalid_graph"; // malformed graph (dangling edge / unknown node) — terminal, not retried (Slice #6)

export interface ExecutionState {
  status: ExecutionStatus;
  currentNodeId: string;
  ctx: Record<string, unknown>;
}

export interface ApprovalInput {
  approved: boolean;
  /** Optional reviewer note recorded with the decision (approve or reject). */
  comment?: string;
}

/** Human approval: delivered as a Signal, awaited via condition() in the workflow. */
export const approvalSignal = defineSignal<[ApprovalInput]>("approval");

/** Payload delivered when an external system resumes a run paused on a wait(webhook)
 *  node. `payload` (the resume request body) becomes the wait node's output so
 *  downstream nodes can branch on / read it. */
export interface ResumeInput {
  payload?: unknown;
}

/** Webhook resume: delivered as a Signal to a run paused on a wait(webhook) node,
 *  awaited via condition() in the workflow (mirrors approvalSignal). */
export const resumeSignal = defineSignal<[ResumeInput]>("resume");

/** Live execution state, readable without disturbing the run. */
export const stateQuery = defineQuery<ExecutionState>("state");

/** The HTTP response a `respondToWebhook` node sets for the webhook ingress to
 *  return synchronously. Undefined until (and unless) such a node runs. */
export interface WebhookResponse {
  statusCode: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Read the pending webhook response (undefined until a respondToWebhook node
 *  sets it) — the ingress polls this to reply synchronously. */
export const webhookResponseQuery = defineQuery<WebhookResponse | undefined>(
  "webhookResponse",
);
