/**
 * Temporal CLIENT interceptor that stamps the active Sentry trace onto the headers of
 * `client.workflow.start` / `signalWithStart` (the calls ExecutionsService makes to launch a
 * run). Combined with the worker's workflow + activity
 * interceptors, this is what makes an API request → workflow → activities show up as ONE
 * connected Sentry trace instead of disconnected roots.
 *
 * Fail-safe: when tracing is off (no Sentry client / not sampled), getSentryTraceHeaders() is
 * empty and we pass the headers through untouched — so this is a no-op with tracing disabled.
 */
import {
  BAGGAGE_HEADER,
  SENTRY_TRACE_HEADER,
  getSentryTraceHeaders,
} from "@naary/observability";
import {
  type WorkflowClientInterceptor,
  defaultPayloadConverter,
} from "@temporalio/client";

/** A Temporal header map value (avoids a direct @temporalio/common dep for the type). */
type Payload = ReturnType<typeof defaultPayloadConverter.toPayload>;
type Headers = Record<string, Payload>;

/** Merge the active Sentry trace headers (as Temporal payloads) into an outgoing header map.
 *  Wrapped so a tracing bug can NEVER break a workflow start — telemetry must not affect the
 *  request path (on any error, return the original headers untouched). */
function injectTrace(headers: Headers): Headers {
  try {
    const trace = getSentryTraceHeaders();
    const extra: Headers = {};
    if (trace[SENTRY_TRACE_HEADER]) {
      extra[SENTRY_TRACE_HEADER] = defaultPayloadConverter.toPayload(
        trace[SENTRY_TRACE_HEADER],
      );
    }
    if (trace[BAGGAGE_HEADER]) {
      extra[BAGGAGE_HEADER] = defaultPayloadConverter.toPayload(
        trace[BAGGAGE_HEADER],
      );
    }
    return Object.keys(extra).length ? { ...headers, ...extra } : headers;
  } catch {
    return headers; // tracing is best-effort; never fail the start over it
  }
}

export function sentryTraceClientInterceptor(): WorkflowClientInterceptor {
  return {
    startWithDetails(input, next) {
      return next({ ...input, headers: injectTrace(input.headers) });
    },
    signalWithStart(input, next) {
      return next({ ...input, headers: injectTrace(input.headers) });
    },
  };
}
