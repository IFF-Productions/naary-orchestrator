// Pure interpreter constants + helpers (split out of workflows.ts — moved
// verbatim, zero behavior change). Everything here is deterministic and
// command-neutral: safe in the Temporal workflow sandbox.
import { ApplicationFailure, TimeoutFailure } from "@temporalio/workflow";
import type { FailureKind } from "@naary/contracts";
import type { TraceCell } from "@naary/dsl";

/** Max sub-workflow nesting depth (a run at this depth refuses to spawn children).
 *  Bounds accidental/infinite recursion — a saved graph that calls itself. */
export const MAX_SUBWORKFLOW_DEPTH = 5;

/** Max items a single forEach will fan out to (child run per item). An array larger
 *  than this trips the circuit breaker — filter/limit upstream first. */
export const MAX_FOREACH_ITEMS = 100;

/** Items model A3: max items a single splitOut region batches through ONE mapNode activity. The N
 *  resolved configs (in) + N outputs (out) ride in Temporal history verbatim (no global codec), so
 *  a very large N would cross the ~2MB payload cap and hard-fail the history write. Fail closed
 *  BELOW the cap with a clear message; larger fan-out belongs in `forEach` (child runs, own history)
 *  or an upstream chunk. (Per-payload claim-check offload to lift this is a later slice.) */
export const MAX_MAP_BATCH_ITEMS = 100;

/** Items model A4: max ACTIVITY executions across a per-item sub-DAG region in one run (design
 *  §0.4.1). A4 regions run item-major and can't batch (branching), so each live activity occurrence is
 *  its own Temporal command → history grows O(live activity executions). Fail closed here — a region
 *  that needs more per-item activity fan-out with branching belongs in `forEach` (child run per item).
 *  Distinct from MAX_MAP_BATCH_ITEMS, which caps a single A3 mapNode's batch, not a running total. */
export const MAX_A4_REGION_ACTIVITY_EXECUTIONS = 100;

/** Per-item INTERMEDIATE trace grid (items-model §0.4.2). Capture is PURE STATE — it writes a
 *  `__regionTrace` key into `ctx` and issues NO Temporal command and NO `stepCount` change, so it is
 *  replay-safe by construction (needs no `patched()`) and rides the CAN snapshot (:1647) + return
 *  (:1786) verbatim like the rest of `ctx`. The caps below are what keep that carried payload bounded
 *  (CLAUDE.md ~2MB): first K items captured (excess → `truncatedItems`, never silent), each cell's
 *  value JSON-capped. A cell is tri-state — value / dead (A4 dead branch) / error. */
export const MAX_TRACE_ITEMS = 50;
export const MAX_TRACE_CELL_BYTES = 1000;
/** Aggregate cap across ALL regions in one run segment. Per-region worst case is ~650KB (50 rows ×
 *  ~13 cols × 1KB), so several full wide regions could otherwise push the CAN snapshot (:1647) + return
 *  (:1786) past Temporal's ~2MB and FAIL AN OTHERWISE-HEALTHY RUN. A diagnostic must never do that:
 *  once this budget is hit, later regions emit `{ unavailable: "budget" }` instead of a grid.
 *  TraceCell / RegionTrace wire types are shared from @naary/dsl (worker writes, web renders). */
export const MAX_TRACE_TOTAL_BYTES = 512_000;

/** One tri-state cell from a node's per-item output. `live=false` ⇒ dead branch (A4). An
 *  `onError:"continue"` result is `{ error }` ⇒ shown as `err`. Otherwise the value, JSON-capped so a
 *  large output can't blow the carried payload (over the cap → a visible truncation marker). PURE. */
export function traceCell(value: unknown, live: boolean): TraceCell {
  if (!live) return { dead: true };
  if (
    value !== null &&
    typeof value === "object" &&
    "error" in (value as object)
  ) {
    return { err: String((value as { error: unknown }).error) };
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return { v: "<unserializable>" };
  }
  if (json !== undefined && json.length > MAX_TRACE_CELL_BYTES) {
    return { v: `<truncated ${json.length} bytes>` };
  }
  return { v: value };
}

/**
 * Sanitized, bounded failure message for a node's error output (onError: "continue").
 * Temporal wraps an activity failure in ActivityFailure whose `cause` carries the real
 * message; unwrap to the innermost cause, then cap length so a huge error can't bloat the
 * ctx/history. Activity errors are already sanitized upstream (toSanitizedRetryable), so
 * this never surfaces secrets.
 */
export function nodeErrorMessage(err: unknown): string {
  let e: unknown = err;
  // Drill through wrapped failures (ActivityFailure → cause → …) to the root message.
  for (let i = 0; i < 5 && e && typeof e === "object" && "cause" in e; i++) {
    const cause = (e as { cause?: unknown }).cause;
    if (!cause) break;
    e = cause;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > 500 ? `${msg.slice(0, 500)}…` : msg;
}

/**
 * Classify a THROWN run failure into the compact {@link FailureKind} persisted on the
 * Execution read-model row (Slice 2 — per-node timing + cost). PURE + DETERMINISTIC:
 * it only inspects the error object Temporal already recorded in history (failure chain
 * types + the activity-sanitized messages), so calling it in workflow code issues no
 * command and replays identically. Mapping is derived from the failure the activity
 * actually observed — never re-guessed later from logs:
 *  - TimeoutFailure in the chain (activity start-to-close elapsed) or the activities'
 *    own *_TIMEOUT types → "timeout"
 *  - QUOTA (provider 429) → "rate_limit"
 *  - BUDGET (monthly cap reservation refused) → "budget"
 *  - HTTP_ERROR_STATUS with a 5xx status in the sanitized message → "upstream_5xx"
 *  - anything else (STOP_AND_ERROR, AUTH, code errors, …) → "error"
 * "rejected"/"budget" for RETURNED terminal statuses are mapped in the
 * setExecutionStatus activity from the status itself, not here.
 */
export function classifyFailure(err: unknown): FailureKind {
  // Walk the wrapped chain (ActivityFailure → cause → …) collecting evidence.
  let e: unknown = err;
  for (let i = 0; i < 6 && e; i++) {
    if (e instanceof TimeoutFailure) return "timeout";
    if (e instanceof ApplicationFailure) {
      const type = e.type ?? "";
      if (type === "QUOTA" || type === "RATE_LIMIT") return "rate_limit";
      if (type === "BUDGET") return "budget";
      if (type.endsWith("_TIMEOUT") || type === "TIMEOUT") return "timeout";
      if (type === "HTTP_ERROR_STATUS" || type === "HTTP_5XX") {
        // http.ts throws "HTTP request returned status <n>" — a 5xx is an upstream
        // failure; a 4xx stays a plain error (the caller's request/config).
        return /\b5\d\d\b/.test(e.message ?? "") ? "upstream_5xx" : "error";
      }
    }
    if (
      typeof e === "object" &&
      "cause" in e &&
      (e as { cause?: unknown }).cause
    ) {
      e = (e as { cause: unknown }).cause;
      continue;
    }
    break;
  }
  return "error";
}
