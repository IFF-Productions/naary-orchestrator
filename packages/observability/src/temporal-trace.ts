/**
 * Sentry trace-context propagation primitives for crossing a process boundary (here: the
 * Temporal API→worker boundary). Sentry-only — NO Temporal imports — so this stays usable from
 * anywhere and never drags Temporal into a non-worker bundle. The Temporal wiring (encoding
 * these strings into workflow/activity headers) lives in apps/{api,worker}.
 *
 * The carrier is the W3C-style pair Sentry already speaks: `sentry-trace` + `baggage`. The
 * producer (API request) emits them with getSentryTraceHeaders(); the consumer (activity)
 * adopts them with continueSentryTrace() so spans it starts become CHILDREN of the API trace —
 * one connected trace across services instead of disconnected roots.
 */
import * as Sentry from "@sentry/node";

/** Header name carrying the active span's trace id + parent span id + sampling decision. */
export const SENTRY_TRACE_HEADER = "sentry-trace";
/** Header name carrying dynamic sampling context (trace-level baggage). */
export const BAGGAGE_HEADER = "baggage";

export interface SentryTraceHeaders {
  [SENTRY_TRACE_HEADER]?: string;
  [BAGGAGE_HEADER]?: string;
}

/**
 * The active trace as propagation header strings. Empty `{}` when tracing is off (no Sentry
 * client) — so callers propagate nothing rather than a bogus context. When active, this reflects
 * the current request/root span; the consumer side stitches onto it.
 */
export function getSentryTraceHeaders(): SentryTraceHeaders {
  if (!Sentry.getClient()) return {};
  const data = Sentry.getTraceData(); // { "sentry-trace"?: string; baggage?: string }
  const out: SentryTraceHeaders = {};
  if (data[SENTRY_TRACE_HEADER])
    out[SENTRY_TRACE_HEADER] = data[SENTRY_TRACE_HEADER];
  if (data[BAGGAGE_HEADER]) out[BAGGAGE_HEADER] = data[BAGGAGE_HEADER];
  return out;
}

/**
 * Run `cb` as a CONTINUATION of an incoming trace, so any span started inside becomes a child of
 * the producer's span. Fail-safe: if there's no incoming trace or tracing is off, just runs `cb`
 * (a normal, possibly-root span) — never throws, never blocks the activity.
 */
export function continueSentryTrace<T>(
  sentryTrace: string | undefined,
  baggage: string | undefined,
  cb: () => T,
): T {
  if (!sentryTrace || !Sentry.getClient()) return cb();
  return Sentry.continueTrace({ sentryTrace, baggage }, cb);
}
