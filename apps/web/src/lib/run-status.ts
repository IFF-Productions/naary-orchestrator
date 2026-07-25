/**
 * Single source of truth for run-status presentation + classification, shared by
 * the Runs, Overview, and Workflows screens so they agree on what "success" means.
 * Statuses come from the control plane (see RunSummary.status / @naary/contracts
 * ExecutionStatus, plus Temporal close reasons + "unknown").
 */
import type { RunState } from "../components";

/** status → StatusPill state + human label. */
export const RUN_STATUS_UI: Record<string, { state: RunState; label: string }> =
  {
    running: { state: "running", label: "Running" },
    awaiting_approval: { state: "paused", label: "Awaiting approval" },
    awaiting_webhook: { state: "paused", label: "Awaiting webhook" },
    // Budget pause-not-fail (Slice 3): a durable PAUSE, not an error — the run
    // resumes when the cap is raised or the month rolls over.
    awaiting_budget: { state: "paused", label: "Paused on budget" },
    completed: { state: "done", label: "Completed" },
    rejected: { state: "error", label: "Rejected" },
    budget_exceeded: { state: "error", label: "Budget exceeded" },
    circuit_open: { state: "error", label: "Circuit open" },
    invalid_graph: { state: "error", label: "Invalid graph" },
    failed: { state: "error", label: "Failed" },
    timed_out: { state: "error", label: "Timed out" },
    terminated: { state: "error", label: "Terminated" },
    canceled: { state: "error", label: "Canceled" },
    unknown: { state: "idle", label: "Unknown" },
  };

export function runStatusUi(s: string): { state: RunState; label: string } {
  return RUN_STATUS_UI[s] ?? { state: "idle", label: s };
}

/** Runs that have reached a final state (used as the denominator for success rate). */
const TERMINAL = new Set([
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

export const isTerminal = (s: string): boolean => TERMINAL.has(s);
export const isSuccess = (s: string): boolean => s === "completed";
/** Terminal and not successful. The AGGREGATE "didn't succeed" bucket — it deliberately
 *  includes `rejected`, because a rejected run is still a run that produced no result
 *  (success-rate denominators, failure charts, the notifications bell all rely on that). */
export const isFailure = (s: string): boolean =>
  isTerminal(s) && s !== "completed";

/** A human declined the run at an approval gate (or it auto-rejected on timeout). Not a
 *  defect: the system did exactly what it was asked. Kept separate from isSystemFailure so
 *  "what broke?" isn't polluted by "what someone said no to". */
export const isRejected = (s: string): boolean => s === "rejected";

/** Terminal, unsuccessful, and NOT a human rejection — a genuine failure worth
 *  investigating (error, timeout, budget, circuit-breaker, cancellation). */
export const isSystemFailure = (s: string): boolean =>
  isFailure(s) && !isRejected(s);

/** Success rate over TERMINAL runs only (null when none have finished yet). */
export function successRate(statuses: string[]): number | null {
  const terminal = statuses.filter(isTerminal);
  if (terminal.length === 0) return null;
  return (terminal.filter(isSuccess).length / terminal.length) * 100;
}
