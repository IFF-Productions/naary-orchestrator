/**
 * DETERMINISTIC workflow interceptor (runs inside the Temporal workflow sandbox). It carries the
 * Sentry trace headers from the workflow's start headers onto EACH scheduled activity, so the
 * activity side can continue the API's trace (see activity-trace-interceptor.ts).
 *
 * Sandbox-safe by construction: it imports ONLY @temporalio types and merely COPIES opaque header
 * Payloads — no Sentry, no Node, no clock, no random, no spans. Loaded via the worker's
 * `interceptors.workflowModules` (NOT the activity/Node interceptors).
 *
 * DETERMINISM / in-flight safety: the trace keys are forwarded ONLY when they were present in the
 * workflow's start headers. A workflow that started BEFORE this was deployed carries none, so
 * scheduleActivity headers are left untouched → the `ScheduleActivityTask` command is byte-identical
 * to history → open runs replay deterministically. No `workflow.patched()` gate is needed.
 */
import type { Payload, WorkflowInterceptors } from "@temporalio/workflow";

// Match the header names emitted by @naary/observability's getSentryTraceHeaders(). Kept as
// literals (NOT imported) so this sandbox module never pulls in the Sentry/Node package.
const TRACE_KEYS = ["sentry-trace", "baggage"] as const;

export function interceptors(): WorkflowInterceptors {
  // Per-execution state — the factory runs once per workflow execution.
  const carried: Record<string, Payload> = {};
  return {
    inbound: [
      {
        execute(input, next) {
          for (const key of TRACE_KEYS) {
            const payload = input.headers[key];
            if (payload) carried[key] = payload;
          }
          return next(input);
        },
      },
    ],
    outbound: [
      {
        scheduleActivity(input, next) {
          if (Object.keys(carried).length === 0) return next(input);
          return next({
            ...input,
            headers: { ...input.headers, ...carried },
          });
        },
      },
    ],
  };
}
