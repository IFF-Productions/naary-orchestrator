// Public interpreter types (split out of workflows.ts — moved verbatim, zero
// behavior change). Type-only module: erased at runtime, nothing to replay.
import type { ExecutionStatus } from "@naary/contracts";

export interface RunGraphResult {
  status: ExecutionStatus;
  ctx: Record<string, unknown>;
  /** The `respondToWebhook` body, if the graph set one. Normally consumed via the
   *  webhookResponseQuery (the ingress polls it), but a CHILD run can't be queried by its
   *  parent mid-flight, so the durable chat session reads the reply from here (design §2.1b,
   *  option i). Undefined when the graph produced no synchronous response. */
  reply?: unknown;
}

/** Non-secret execution context. `tenantId` is fine in workflow args/history;
 *  the provider KEY is never here — it's fetched inside the activity by tenantId.
 *
 *  Budget caps are SNAPSHOTTED here at start (the api reads the tenant budget and
 *  passes them in) so enforcement stays deterministic — no DB read in the workflow.
 *  Enforcement is opt-in per cap: a cap that is undefined is not enforced. */
export interface RunGraphCtx {
  tenantId: string;
  /** The environment this run executes in (Slice 5b). Set at start from the endpoint's env (triggers)
   *  or the caller's active env (manual/test); rides continueAsNew inside this ctx. Optional so a run
   *  started before 5b (no env in its recorded ctx) resolves to the tenant default in-activity. Like
   *  the rest of this ctx it is a NON-SECRET id that rides workflow history — no keys/tokens ever do
   *  (Tier-1 #4); the activity fetches the env's secrets by (tenantId, environmentId) in-activity. */
  environmentId?: string;
  /** The saved-graph key this run executes — recorded for the Runs list. */
  workflowKey?: string;
  perExecutionCapUsd?: number;
  maxStepsPerRun?: number;
  /** The tenant's onBudgetExceeded policy SNAPSHOTTED at start (Slice 3). Drives the
   *  workflow-side per-run-cap decision only: "pause" parks the run (awaiting_budget)
   *  instead of the terminal budget_exceeded. REPLAY SAFETY: no pre-Slice-3 run's
   *  snapshot carries "pause" (the value didn't exist), and the new commands are ALSO
   *  gated by wf.patched("budget-pause-v1"). Monthly-cap policy is NOT read from here —
   *  the agent activity reads it live per reservation (see agent.ts BUDGET_PAUSE). */
  onBudgetExceeded?: "reject" | "downgrade" | "pause";
  /** The version-pinned graph snapshot this run executes (Slice #5). Carried in
   *  history for traceability; the interpreter walks the passed graph as-is. */
  graphContentHash?: string;
  graphVersion?: number;
  /** Force continueAsNew after this many steps (Slice #6) — deterministic, for
   *  long loops + tests. When unset, only Temporal's continueAsNewSuggested trips. */
  continueAsNewAfterSteps?: number;
  /** Nesting depth for executeSubWorkflow runs (top-level = 0/undefined). A child
   *  run is spawned with depth+1; the interpreter refuses to nest past
   *  MAX_SUBWORKFLOW_DEPTH so a self-referential graph can't recurse forever. */
  subWorkflowDepth?: number;
  /** The saved-graph key to run (detached) if THIS run fails — an error-handler
   *  workflow. Resolved + started in-activity on failure. */
  errorWorkflowKey?: string;
  /** True when this run IS an error-handler (started by another run's failure).
   *  Suppresses re-firing a handler so a failing handler can't loop. */
  isErrorHandler?: boolean;
  /** Single-node TEST mode (design SINGLE-NODE-EXECUTION.md slice 3): seed ctx from `seededCtx`
   *  (upstream outputs, from pins) and run just the target node's activity. Suppresses the
   *  Execution/read-model recording so a test never shows up as a "run" — but the activity is
   *  real (secrets in-activity) and any LLM/tool spend is still metered (its own UsageEvent). */
  test?: boolean;
  /** Node outputs to pre-populate ctx with (test mode) — the target node reads these as its
   *  upstream inputs, so no upstream nodes execute. */
  seededCtx?: Record<string, unknown>;
}

/** Carried across continueAsNew so a long/looping run resumes with state intact
 *  (Slice #6) — the same graph snapshot is passed again as the first arg. */
export interface ResumeState {
  ctx: Record<string, unknown>;
  costUsd: number;
  stepCount: number;
  startNodeId: string;
  /** Fan-in arrival counts per merge node id (Slice N5). Carried so a run that
   *  continueAsNews mid-join resumes its counts. Plain object (CAN-safe). */
  mergeArrivals?: Record<string, number>;
}
