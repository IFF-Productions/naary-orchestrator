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
export const isFailure = (s: string): boolean =>
  isTerminal(s) && s !== "completed";

/** Success rate over TERMINAL runs only (null when none have finished yet). */
export function successRate(statuses: string[]): number | null {
  const terminal = statuses.filter(isTerminal);
  if (terminal.length === 0) return null;
  return (terminal.filter(isSuccess).length / terminal.length) * 100;
}
