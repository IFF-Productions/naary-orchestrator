/**
 * Wrap every activity so each invocation emits ONE structured lifecycle line — a completion
 * record carrying the run's correlation ids, wall-clock duration, and success/failure — and,
 * on UNEXPECTED failure, a Sentry issue (captureActivityFailure; expected user-fixable
 * credential failures are filtered there). This is
 * the universal "what is going on" timeline: unlike the hand-written domain logs (tokens, cost,
 * provider), every side-effecting node gets a line for free, including future activities and —
 * importantly — the ones that currently log NOTHING on failure.
 *
 * WHY HERE, not in @naary/observability: this needs @naary/logging (createLogger), which itself
 * depends on @naary/observability — putting it there would be a dependency cycle. The worker is
 * the one place that already imports both, so the composition lives here.
 *
 * TRACE CORRELATION: compose as `traceActivities(logActivities(activities))` so the log fires
 * INSIDE the active `activity.<name>` span — createLogger's mixin then stamps each line with the
 * span's trace/span id, cross-linking the stdout log to its Sentry trace (and, via pinoIntegration,
 * the Sentry Log). See worker.ts.
 *
 * SECURITY (CLAUDE.md Tier-1 §4): only allowlisted correlation ids ({@link activityIdAttrs}) and a
 * SAFE error *class* (never the message/stack, which can carry argv/prompt/provider bodies) are
 * logged. The logger additionally scrubs every field. Never widen this to log raw args or `meta`.
 *
 * DETERMINISM: runs on the worker (activity) side only — never in workflows.ts. `Date.now()` is
 * fine here (activities do I/O and read the clock); it would break replay only in workflow code.
 */
import { activityIdAttrs, captureActivityFailure } from "@naary/observability";
import type { Logger } from "@naary/logging";

/** The logger surface this wrapper needs — a subset of pino's Logger, so tests can inject a stub. */
type ActivityLogger = Pick<Logger, "info" | "warn">;

/** True for any PromiseLike — a native Promise OR a foreign/cross-realm thenable. `instanceof
 *  Promise` misses the latter (different realm) and would log a false success before it settles. */
function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    v != null &&
    (typeof v === "object" || typeof v === "function") &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

function logCompletion(
  log: ActivityLogger,
  activity: string,
  ids: Record<string, string | number | boolean>,
  startMs: number,
  ok: boolean,
  err?: unknown,
): void {
  const base = { activity, ...ids, ok, durationMs: Date.now() - startMs };
  if (ok) {
    log.info(base, "activity completed");
  } else {
    log.warn(
      // A SAFE classifier only — the error's class, never its message/stack.
      { ...base, errorName: err instanceof Error ? err.name : "unknown" },
      "activity failed",
    );
    // ALSO a Sentry ISSUE (the #339 deferred follow-up): the error here is exactly what
    // enters Temporal history — already sanitized by the activity — and beforeSend scrubs
    // again on egress. Expected user-fixable failures (bad credential AUTH/QUOTA, …) are
    // filtered inside so issues stay operator-relevant. Fires within the activity span
    // (traceActivities wraps this), so the issue is linked to its trace.
    captureActivityFailure(activity, ids, err);
  }
}

/**
 * Wrap each function in an activities map so it logs a completion line on success and failure.
 * Non-function entries (e.g. `__httpDeps`) pass through by reference, and Temporal's dispatch-by-key
 * is preserved (only values are wrapped). The wrapped function is observe-and-rethrow: it NEVER
 * alters the return value and rethrows the IDENTICAL error object, so activity semantics —
 * retryability (401/429 → non-retryable), error type — are untouched.
 */
export function logActivities<T extends Record<string, unknown>>(
  activities: T,
  log: ActivityLogger,
): T {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(activities)) {
    if (typeof value !== "function") {
      out[name] = value;
      continue;
    }
    const fn = value as (...a: unknown[]) => unknown;
    out[name] = (...args: unknown[]): unknown => {
      const ids = activityIdAttrs(args);
      const startMs = Date.now();
      let result: unknown;
      try {
        result = fn(...args);
      } catch (err) {
        logCompletion(log, name, ids, startMs, false, err);
        throw err;
      }
      if (isThenable(result)) {
        // Normalize with Promise.resolve so a foreign thenable is handled the same as a native
        // Promise; the returned promise resolves to the identical value / rejects with the
        // identical error, so activity semantics are preserved.
        return Promise.resolve(result).then(
          (v) => {
            logCompletion(log, name, ids, startMs, true);
            return v;
          },
          (err) => {
            logCompletion(log, name, ids, startMs, false, err);
            throw err;
          },
        );
      }
      logCompletion(log, name, ids, startMs, true);
      return result;
    };
  }
  return out as T;
}
