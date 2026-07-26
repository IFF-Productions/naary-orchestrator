import type { ExecutionStatus, NodeTimeEntry } from "@naary/contracts";

/** Circuit breaker default when a tenant has no budget configured (safety net). */
export const DEFAULT_MAX_STEPS_PER_RUN = 50;

/** workflowKey of the demo graph that POST /executions starts. */
export const DEFAULT_WORKFLOW_KEY = "default";

/** A run in the list, with live status + accumulated cost from Temporal. */
export interface RunSummary {
  workflowId: string;
  workflowKey: string | null;
  /**
   * The workflow's display NAME at read time, or null when it can't be resolved (a pre-migration run
   * with no key, or a workflow since deleted). Callers render `workflowName ?? workflowKey ?? "—"`.
   *
   * Resolved rather than stored: a run records the KEY it started (stable, and what the trigger
   * referenced), while the name is editable and env-scoped. Snapshotting it would show the old name
   * after a rename — and renaming a workflow is precisely when you go looking at its runs.
   */
  workflowName?: string | null;
  /** App status (running | awaiting_approval | awaiting_webhook | awaiting_budget |
   *  completed | rejected | budget_exceeded | circuit_open | invalid_graph) or a
   *  Temporal close reason (failed | timed_out | terminated | canceled) or "unknown"
   *  if unreachable. */
  status:
    | ExecutionStatus
    | "failed"
    | "timed_out"
    | "terminated"
    | "canceled"
    | "unknown";
  /** Accumulated run cost (from the workflow ctx), or null when unavailable. */
  costUsd: number | null;
  /** When the workflow started (Temporal), ISO. */
  startedAt: string;
  /** DB record time, ISO (kept for time-bucketed charts). */
  createdAt: string;
  /** When the run reached a terminal status (worker-stamped, Slice 2); null for
   *  in-flight runs AND runs predating the stamp — consumers render "—". */
  finishedAt: string | null;
  /** finishedAt − createdAt in ms; null whenever finishedAt is null (never derived
   *  from "now" — an in-flight age is not a duration). */
  durationMs: number | null;
  /** Compact failure classification (timeout | upstream_5xx | rate_limit | budget |
   *  rejected | error) on terminal failures; null → fall back to the status. */
  failureKind: string | null;
  /** Soft-archived (hidden from the default Runs list). */
  archived: boolean;
  /** The GraphDefinition version this run snapshotted at start; null for
   *  pre-migration rows (version wasn't recorded). */
  graphVersion: number | null;
}

/** One page of runs plus the opaque cursor for the next page (null = no more). */
export interface RunPage {
  items: RunSummary[];
  nextCursor: string | null;
}

/** Live run detail — like ExecutionState but with the widened status (a run can be
 *  Temporal-failed/terminated, which ExecutionStatus alone can't express). */
export interface RunStateView {
  status: RunSummary["status"];
  /** The node the run is at: the live node on a running/paused run, or — for a THROWN
   *  failure whose ctx isn't queryable — the node it died on (#525). "" when unknown. */
  currentNodeId: string;
  ctx: Record<string, unknown>;
  /** #525 — node ids known to have run, for a failed run whose ctx came back empty (the
   *  UI marks them done + the currentNodeId failed, instead of "skipped"). Empty when the
   *  ctx itself carries the outputs (running/completed) — the UI derives from ctx then. */
  executedNodeIds: string[];
  /** Per-node timing map the interpreter stamped into ctx (Slice 2), surfaced as a
   *  first-class field so consumers don't grope the opaque ctx. Null when the run
   *  predates the feature or the ctx is unavailable (Temporal-level failure). */
  nodeTimes: Record<string, NodeTimeEntry> | null;
  /** Live spend-so-far of this run in USD (Slice 3 — the interpreter's deterministic
   *  cost accumulator, via the state query; closed runs fall back to ctx.__costUsd).
   *  Null when unavailable (pre-feature worker / Temporal-level failure). */
  spentUsd: number | null;
  /** The per-run cap this run enforces (start snapshot, refreshed after a budget-pause
   *  resume). Null when no cap is configured / the run is closed — consumers must not
   *  fabricate a budget meter without it. */
  perExecutionCapUsd: number | null;
}

/** Approver routing display summary on an awaiting row (Slice 1). */
export interface ApproverSummary {
  emails: string[];
  groups: { id: string; name: string }[];
}

/** A run paused at a humanApproval node, enriched with the node's prompt (resolved
 *  from the stored graph) so the approvals inbox can show WHAT is being approved.
 *  The Slice-1 fields (contextFields/slaHours/dueAt/approvers/…) come from the
 *  awaiting record the worker snapshotted at pause time (ctx.__approval); they are
 *  null for gates without routing/SLA config (and for pre-Slice-1 paused runs). */
export interface AwaitingApproval {
  workflowId: string;
  workflowKey: string | null;
  /** The workflow's display name at read time, or null when unresolvable. Same resolve-don't-store
   *  reasoning as RunSummary.workflowName. */
  workflowName?: string | null;
  nodeId: string;
  title: string;
  instructions: string | null;
  createdAt: string;
  /** When the gate paused (worker clock at pause time), ISO. */
  pausedAt: string | null;
  /** The gate's display-only SLA in hours. */
  slaHours: number | null;
  /** pausedAt + slaHours, computed server-side (null unless both exist). */
  dueAt: string | null;
  /** Resolved context fields (expressions evaluated at pause time). */
  contextFields: Record<string, string> | null;
  /** Who may decide (display summary; enforcement happens on the approve path). */
  approvers: ApproverSummary | null;
  /** Escalation display info (notify-only v1). */
  escalateAfterHours: number | null;
  escalateTo: string | null;
}

/** One run's outcome in a batch approve/reject — ok:false carries why it slipped. */
export interface BatchDecisionResult {
  workflowId: string;
  ok: boolean;
  error?: string;
}

/** Temporal closed-status name → our UI status string (COMPLETED handled via result()). */
export const TEMPORAL_CLOSED_STATUS: Record<string, RunSummary["status"]> = {
  FAILED: "failed",
  TIMED_OUT: "timed_out",
  TERMINATED: "terminated",
  CANCELLED: "canceled",
  CANCELED: "canceled",
  CONTINUED_AS_NEW: "running",
};

/** Temporal FAILURE states only (for reconciling a stuck-non-terminal PG row). */
export const TEMPORAL_FAILED_STATUS: Record<string, RunSummary["status"]> = {
  FAILED: "failed",
  TIMED_OUT: "timed_out",
  TERMINATED: "terminated",
  CANCELLED: "canceled",
  CANCELED: "canceled",
};

/** One entry in a run's execution log (derived from a Temporal history event). */
export interface RunEvent {
  id: number;
  /** Coarse kind for the UI icon/colour. */
  kind:
    | "started"
    | "activity"
    | "signal"
    | "timer"
    | "completed"
    | "error"
    | "continued";
  label: string;
  at: string | null;
  detail?: string;
}

/** The subset of Temporal history-event fields we read (one attrs object is set). */
export interface RawHistoryEvent {
  eventId?: number | string | { toString(): string };
  eventTime?: {
    seconds?: number | string | { toString(): string };
    nanos?: number;
  };
  workflowExecutionStartedEventAttributes?: unknown;
  activityTaskScheduledEventAttributes?: { activityType?: { name?: string } };
  activityTaskCompletedEventAttributes?: unknown;
  activityTaskFailedEventAttributes?: { failure?: { message?: string } };
  workflowExecutionSignaledEventAttributes?: { signalName?: string };
  timerStartedEventAttributes?: unknown;
  timerFiredEventAttributes?: unknown;
  workflowExecutionCompletedEventAttributes?: unknown;
  workflowExecutionFailedEventAttributes?: { failure?: { message?: string } };
  workflowExecutionContinuedAsNewEventAttributes?: unknown;
}

/** Run statuses that won't change again — the read-model is authoritative for these. */
export const TERMINAL_STATUSES = new Set([
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
