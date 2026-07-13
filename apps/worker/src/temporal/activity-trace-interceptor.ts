/**
 * Activity (Node-side) interceptor that ADOPTS the Sentry trace carried on the activity headers
 * (put there by the client interceptor + the workflow interceptor) via continueSentryTrace(). Any
 * span started inside the activity — notably the `activity.<name>` span from traceActivities() —
 * then becomes a CHILD of the API request span, so the whole API→worker→activity chain is one trace.
 *
 * Fail-safe: no trace header (or tracing off) → continueSentryTrace just runs the activity, so this
 * is a no-op with tracing disabled and never breaks activity execution.
 */
import {
  BAGGAGE_HEADER,
  SENTRY_TRACE_HEADER,
  continueSentryTrace,
} from "@naary/observability";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";
import { defaultPayloadConverter } from "@temporalio/worker";
import type { Payload } from "@temporalio/workflow";

/** Decode a header Payload back to its string, tolerating an absent/garbled value. */
function decodeHeader(payload: Payload | undefined): string | undefined {
  if (!payload) return undefined;
  try {
    return defaultPayloadConverter.fromPayload<string>(payload);
  } catch {
    return undefined;
  }
}

export const sentryTraceActivityInterceptors: ActivityInterceptorsFactory =
  () => ({
    inbound: {
      execute(input, next) {
        const sentryTrace = decodeHeader(input.headers[SENTRY_TRACE_HEADER]);
        const baggage = decodeHeader(input.headers[BAGGAGE_HEADER]);
        return continueSentryTrace(sentryTrace, baggage, () => next(input));
      },
    },
  });
