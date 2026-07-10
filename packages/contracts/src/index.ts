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

/** Workflow type name for the durable per-session chat workflow (design §2.1b, option A). */
export const CHAT_SESSION_WORKFLOW = "chatSession";

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

// --- Durable per-session chat (design §2.1b, option A) ---

/** One user message signaled into a chat session workflow. `turnId` is minted by the API (a uuid,
 *  never in workflow code) so concurrent messages get DISTINCT replies — the fix for the reply-Query
 *  cross-talk race that got option A deferred. */
export interface ChatTurnInput {
  message: string;
  turnId: string;
}

/** Deliver a user message to the durable chat session (queued + processed in order). */
export const chatMessageSignal =
  defineSignal<[ChatTurnInput]>("chatSessionMessage");

/** The reply for one turn: `pending` until the session finishes running the graph for that
 *  `turnId`, then `replied` with the `respondToWebhook` body. `unknown` once the reply has aged out
 *  of the session's bounded recent-replies window (the client should stop polling and treat it as
 *  timed out). */
export interface ChatReplyState {
  status: "pending" | "replied" | "unknown";
  reply?: unknown;
}

/** Read a turn's reply by `turnId` — the API polls this after signaling (turn-id keyed, so two
 *  concurrent messages never read each other's reply). */
export const chatReplyQuery = defineQuery<ChatReplyState, [string]>(
  "chatReply",
);
