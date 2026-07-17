/**
 * Wrap every activity so each invocation emits ONE structured lifecycle line — a completion
 * record carrying the run's correlation ids, wall-clock duration, and success/failure. This is
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
import { activityIdAttrs } from "@naary/observability";
import type { Logger } from "@naary/logging";

/** The logger surface this wrapper needs — a subset of pino's Logger, so tests can inject a stub. */
type ActivityLogger = Pick<Logger, "info" | "warn">;

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
      if (result instanceof Promise) {
        return result.then(
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
