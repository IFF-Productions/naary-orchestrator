import { defineQuery, defineSignal } from "@temporalio/workflow";

/**
 * Execution protocol shared by the worker (workflow) and the api (client).
 * Client-safe: `defineSignal`/`defineQuery` are pure factories, so importing
 * this module in client code does NOT pull in workflow-sandbox runtime. (The
 * proxyActivities call that *is* sandbox-only lives in workflows.ts, not here.)
 */

export const TASK_QUEUE = "orchestrator";

/** Dedicated queue for long/heavy activities (Queue-mode §3.3) so they can't starve interactive
 *  latency. A separate worker pool polls it (docker-compose `worker-heavy`, or a process with
 *  WORKER_TASK_QUEUE=orchestrator-heavy). The workflow statically routes codeAgent here, behind a
 *  wf.patched gate that preserves REPLAY determinism only (a history that already ran codeAgent
 *  keeps its original queue). A run reaching codeAgent for the first time after this deploy takes
 *  this queue — so, hard deploy ordering: a heavy poller MUST be up before the routing code, else
 *  those activities strand. */
export const TASK_QUEUE_HEAVY = "orchestrator-heavy";

/** Workflow type name — lets the client start runGraph by name if desired. */
export const RUN_GRAPH_WORKFLOW = "runGraph";

/** Workflow type name for the durable per-session chat workflow (design §2.1b, option A). */
export const CHAT_SESSION_WORKFLOW = "chatSession";

/** Registered name of the eval-batch workflow (#575) — one execution per eval run, launching one
 *  CHILD `runGraph` per golden case. Must match the export name in the worker's workflows.ts. */
export const EVAL_RUN_WORKFLOW = "evalRun";

export type ExecutionStatus =
  | "running"
  | "awaiting_approval"
  | "completed"
  | "rejected"
  | "awaiting_webhook" // paused on a wait(webhook) node until an external resume call
  | "awaiting_budget" // paused on a budget rejection under onBudgetExceeded="pause" — resumes via budgetResumeSignal (redesign Slice 3)
  | "budget_exceeded" // per-execution cost cap hit (Slice #3)
  | "circuit_open" // max-step circuit breaker tripped (Slice #3)
  | "invalid_graph"; // malformed graph (dangling edge / unknown node) — terminal, not retried (Slice #6)

export interface ExecutionState {
  status: ExecutionStatus;
  currentNodeId: string;
  ctx: Record<string, unknown>;
  /** Live spend-so-far of THIS run in USD (the interpreter's deterministic cost
   *  accumulator — the same figure ctx.__costUsd mirrors). Optional: pre-feature
   *  workers' query handlers don't return it (redesign Slice 3, live run spend). */
  spentUsd?: number;
  /** The per-run cap this run enforces (snapshotted at start, refreshed after a
   *  budget-pause resume). Absent when no cap is configured — consumers must not
   *  fabricate a meter without it. */
  perExecutionCapUsd?: number;
}

export interface ApprovalInput {
  approved: boolean;
  /** Optional reviewer note recorded with the decision (approve or reject). */
  comment?: string;
  /**
   * DISPLAY identity of whoever decided (email, else OIDC subject, else "api-token"; the public
   * signed-link path sends "public-link"). Added for #576: a forced-approval TOOL gate resolves
   * inside the interpreter, which then writes the AuditEvent naming actor + tool + decision — the
   * API's request-scoped AuditInterceptor cannot cover a decision the worker observes as a Signal
   * (and never covered the public link at all, which has no `req.principal`).
   *
   * NOT a secret and NOT an authorization input: the API has already authenticated and authorized
   * the decider before signalling. Optional, so an old API signalling a new worker is fine.
   */
  actor?: string;
}

/** ctx key under which the interpreter stores the {@link ApprovalAwaitingRecord} while a
 *  humanApproval gate with Slice-1 fields is paused. `__`-prefixed = reserved/system (stripped
 *  from user-visible snapshots like the code node's ctx). */
export const APPROVAL_CTX_KEY = "__approval";

/**
 * The awaiting-approval record (REDESIGN-FUNCTIONALITY-GAPS.md Slice 1). Snapshotted by the
 * worker's pause-side activity — contextFields expressions are resolved against the run ctx AT
 * PAUSE TIME, group ids get display names — and stored in the workflow ctx under
 * {@link APPROVAL_CTX_KEY}, where the API's stateQuery reads it for `GET /executions/awaiting`,
 * decide-time approver enforcement, and the public approve prompt. Absent for gates without any
 * Slice-1 field (old graphs keep their exact pre-existing path).
 */
export interface ApprovalAwaitingRecord {
  /** The paused humanApproval node. */
  nodeId: string;
  /** When the gate paused (activity clock), ISO — dueAt = pausedAt + slaHours. */
  pausedAt: string;
  /** Resolved, display-ready context fields (secrets are never resolved — see prepareApproval). */
  contextFields?: Record<string, string>;
  slaHours?: number;
  /** Approver routing snapshot: raw emails + groups with display names. */
  approvers?: {
    emails: string[];
    groups: { id: string; name: string }[];
  };
  remindAfterHours?: number[];
  escalateAfterHours?: number;
  escalateTo?: string;
  /**
   * FORCED-APPROVAL TOOL GATE (#576). Present only when the pause is a guardrail tool gate rather
   * than a `humanApproval` node: the `connectionId:tool` / `provider:action` ref the run is waiting
   * to be allowed to call. Lets the approval inbox / Slack message say WHAT is being approved, and
   * is what the interpreter names in the AuditEvent. A ref, never arguments.
   */
  toolRef?: string;
}

/**
 * ctx key under which the interpreter MEMOIZES tool-policy verdicts (#576) — a
 * `ref → "allow" | "deny" | "approval"` map filled lazily by the `resolveToolPolicy` activity, one
 * entry per DISTINCT resolved tool ref the run actually reaches.
 *
 * TOTAL, including "allow": absence means "not yet evaluated", NEVER "allowed". Representing allow
 * by absence would make an unregistered ref indistinguishable from a permitted one, which is exactly
 * how a `{{ }}`-templated tool name could slip past a deny-list.
 *
 * Memoized rather than re-read per node for the same reason `$vars` are loaded once. A run that
 * pauses for days therefore enforces the policy as it stood when that ref was first reached in the
 * segment — the same "snapshot at start" contract the pinned graph version already has.
 */
export const TOOL_POLICY_CTX_KEY = "__toolPolicy";

/** ctx key under which the interpreter records per-node execution times (Slice 2 —
 *  per-node timing + cost). `__`-prefixed = reserved/system, so it is stripped from
 *  user-visible snapshots (code node ctx, sub-workflow projections) like __approval. */
export const NODE_TIMES_CTX_KEY = "__nodeTimes";

/**
 * One executed node's timing window (REDESIGN-FUNCTIONALITY-GAPS.md Slice 2), stamped by
 * the interpreter with DETERMINISTIC workflow time (the Temporal TS sandbox's per-task
 * `Date.now()` — never a wall clock; see run-graph.ts for the full justification).
 * Epoch ms. Durations are workflow-task-granular: an activity node's window spans its
 * activity execution; a pure node executes within one task, so its window may be 0ms.
 * When a node runs MORE THAN ONCE (loop back-edge, items region), `s`/`f` hold the LAST
 * iteration's window and `n`/`totalMs` aggregate all passes (absent for a single pass).
 */
export interface NodeTimeEntry {
  /** Started at (epoch ms, workflow time). */
  s: number;
  /** Finished at (epoch ms, workflow time). */
  f: number;
  /** Total executions, when > 1 (loops / items regions). */
  n?: number;
  /** Sum of all passes' durations in ms, when n > 1. */
  totalMs?: number;
}

/** Compact terminal-failure classification persisted on the Execution read-model row
 *  (Slice 2). Derived in the worker from the failure the interpreter/activity actually
 *  observed. Consumers fall back to the close status when absent (pre-feature runs). */
export type FailureKind =
  "timeout" | "upstream_5xx" | "rate_limit" | "budget" | "rejected" | "error";

/**
 * WHICH STATUSES ARE "TERMINAL" — three different questions that were being answered by five
 * separate lists, one of which disagreed with the others (#805).
 *
 * They are genuinely different sets, so they get genuinely different names. The old shared name
 * `TERMINAL_STATUSES` across two of these concepts was the actual hazard: it made the narrower
 * list look like a copy that had drifted, which invites "fixing" it by widening — and that would
 * silently change what the worker classifies and when it stamps `finishedAt`.
 */

/**
 * EVERY status a finished run can be reported under: the terminals a workflow returns PLUS the
 * Temporal close reasons the API maps (`failed`/`timed_out`/`terminated`/`canceled`), which no
 * workflow ever assigns itself.
 *
 * The question "is this run over?" — asked by the API, the CLI's `watch`, and the SPA. The CLI and
 * the SPA keep their own copies on purpose (see the drift test in test/): `@naary/cli` is
 * deliberately dependency-free ("Node built-ins only; imports NO server code" — its package.json),
 * and this module calls `defineSignal` at load, so importing it into the browser bundle would drag
 * in the Temporal SDK. Those copies are CHECKED rather than shared.
 */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "rejected",
  "budget_exceeded",
  "circuit_open",
  "invalid_graph",
  "failed",
  "timed_out",
  "terminated",
  "canceled",
]);

/**
 * The terminals a `runGraph` workflow itself reports — i.e. everything `setExecutionStatus` can
 * actually receive. NARROWER than the above by design, and it must stay that way: it gates
 * `finishedAt` and the status-derived `failureKind`.
 *
 * Verified when this was extracted: `timed_out`/`terminated`/`canceled` appear nowhere in the
 * worker or the API outside the Temporal close-status map, so none of them ever reaches that
 * activity. (A canceled run's row therefore never gets a `finishedAt` at all — a real gap, filed
 * separately rather than papered over by widening this set.)
 */
export const RETURNED_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "rejected",
  "budget_exceeded",
  "circuit_open",
  "invalid_graph",
  "failed",
]);

/**
 * The returned terminals that mean the run did NOT succeed — what decides whether the tenant's
 * error-handler graph starts and whether a failure notification goes out.
 *
 * Excludes `failed`, which is the status the failure path WRITES after already knowing it threw;
 * the workflow tests `threw !== undefined` separately for that.
 */
export const RETURNED_FAILURE_STATUSES: ReadonlySet<string> = new Set([
  "rejected",
  "budget_exceeded",
  "circuit_open",
  "invalid_graph",
]);

/**
 * How long a newly minted approval link stays valid. Generous — a human-in-the-loop pause can last
 * days; the expiry claim exists so a leaked link isn't a forever-credential.
 *
 * Shared because BOTH sides must agree: the worker mints these links in its notification activity
 * and the API verifies them. They were two identical constants in two files, each with a comment
 * saying it had to match the other — so drift here means a link Slack shows and the API rejects.
 */
export const APPROVAL_LINK_TTL_SECONDS = 7 * 24 * 3600;

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

/** Payload for {@link budgetResumeSignal}. tenantId-ONLY — informational (who triggered the
 *  resume); never secrets, never budget figures (the workflow re-reads those in-activity). */
export interface BudgetResumeInput {
  tenantId: string;
}

/** Budget resume (redesign Slice 3, pause-not-fail): delivered to a run parked in
 *  `awaiting_budget` (its budget policy is "pause" and a reservation / the per-run cap
 *  refused). Sent by the API on PUT /tenants/:id/budget (cap raise / policy change) and by
 *  the month-rollover boot reconcile. The workflow then RETRIES the refused reservation/
 *  node — durable Signal + condition(), never a poll (CLAUDE.md Tier-1 rule 5). */
export const budgetResumeSignal =
  defineSignal<[BudgetResumeInput?]>("budgetResume");

/** Live execution state, readable without disturbing the run. */
export const stateQuery = defineQuery<ExecutionState>("state");

/** A single RAG source surfaced to the hosted chat as a "citation" (issue #482). Derived from a
 *  vectorQuery node's retrieved chunks — the tenant's OWN indexed documents, returned to the same
 *  tenant's chat, so surfacing them to that chat is in-tenant (never cross-tenant). A privacy-safe
 *  subset: the chunk `snippet` (truncated) + similarity `score`, tagged with the `source` collection.
 *  Citations ride ONLY the chat/webhook response — never the usage ledger, telemetry, or history
 *  beyond the reply body that already lands there. */
export interface Citation {
  /** Where the chunk came from — the vectorQuery node's `collection` (its logical namespace). */
  source?: string;
  /** A snippet of the matched chunk text (truncated for payload safety). */
  snippet: string;
  /** Cosine similarity of the match (1 = identical), when available. */
  score?: number;
}

/** The HTTP response a `respondToWebhook` node sets for the webhook ingress to
 *  return synchronously. Undefined until (and unless) such a node runs. */
export interface WebhookResponse {
  statusCode: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** RAG sources retrieved during the run (issue #482), for the hosted chat's "Sources" list.
   *  Present only when the graph ran a vectorQuery node that matched chunks. The webhook ingress
   *  ignores this field (it returns only body/statusCode/headers) — only the chat controller reads
   *  it — so a plain webhook's external caller never receives retrieved chunk text. */
  citations?: Citation[];
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

/** The reply for one turn: `pending` until the session finishes running the graph for that `turnId`,
 *  then `replied` with the `respondToWebhook` body. `no_reply` when the turn ran but the graph set no
 *  synchronous response (no respondToWebhook node) — a TERMINAL state, so the client stops polling and
 *  reports "started" (matching the non-durable path), rather than waiting out the timeout. `unknown`
 *  once the reply has aged out of the session's bounded recent-replies window. */
export interface ChatReplyState {
  status: "pending" | "replied" | "no_reply" | "unknown";
  reply?: unknown;
  /** RAG sources for this turn (issue #482) — derived from the turn's vectorQuery matches. Present
   *  only alongside a `replied` status when the turn ran a vectorQuery that matched chunks. */
  citations?: Citation[];
}

/** Read a turn's reply by `turnId` — the API polls this after signaling (turn-id keyed, so two
 *  concurrent messages never read each other's reply). */
export const chatReplyQuery = defineQuery<ChatReplyState, [string]>(
  "chatReply",
);
