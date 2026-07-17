/**
 * Sentry wiring shared by the API + worker. OFF unless SENTRY_DSN is set (mirrors
 * the OIDC pattern), so existing deployments are unchanged. Every event passes
 * through scrubEvent first — secrets must never reach telemetry (CLAUDE.md).
 *
 * Do NOT import this from workflow code (workflows.ts): capturing is I/O and would
 * break deterministic replay. API bootstrap, the exception filter, and activities
 * (worker side) only.
 */
import * as Sentry from "@sentry/node";
import { scrubEvent } from "./scrub";

export { redactString, deepScrub, scrubEvent } from "./scrub";
export {
  withSpan,
  Traced,
  TracedClass,
  traceActivities,
  activityIdAttrs,
  type SpanAttrs,
  type SpanOptions,
} from "./spans";
export {
  metricCount,
  metricDistribution,
  metricGauge,
  type MetricAttributes,
} from "./metrics";
export {
  SENTRY_TRACE_HEADER,
  BAGGAGE_HEADER,
  getSentryTraceHeaders,
  continueSentryTrace,
  type SentryTraceHeaders,
} from "./temporal-trace";

let enabled = false;

/**
 * Scrub an outgoing Sentry payload, but NEVER throw into the SDK's send pipeline: if scrubbing
 * fails, DROP the event (return null) rather than risk shipping unscrubbed data. Belt to
 * deepScrub's braces — a scrub bug must degrade telemetry, not crash the request path (a throw
 * here previously spammed errors on every traced request via beforeSendTransaction).
 */
function safeScrub(event: unknown): unknown {
  try {
    return scrubEvent(event as Record<string, unknown>);
  } catch {
    return null; // drop rather than leak
  }
}

export function initSentry(opts: { component: "api" | "worker" }): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return; // disabled — no DSN configured
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.SENTRY_RELEASE,
    // Opt-in performance tracing; 0 (off) unless explicitly configured.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0"),
    // Sentry Logs: forward our structured pino logs to Sentry's Logs product so they're
    // searchable next to traces + errors (auto-correlated to the active trace). Both the
    // flag and the integration are required; pinoIntegration auto-instruments every pino
    // logger, so createLogger() needs no transport wiring.
    enableLogs: true,
    // Auto-instrument Prisma (every DB query → a child span; Prisma v6/v7 out of the box,
    // no schema change) and pino (every log line → a Sentry log). Merged WITH the SDK
    // defaults (httpIntegration etc. preserved). Relies on initSentry() running before
    // @prisma/client / the pino loggers are created — main.ts + worker.ts call it before
    // the app/activity imports (CommonJS preserves require order).
    integrations: [
      Sentry.prismaIntegration(),
      Sentry.pinoIntegration(),
      // Node runtime metrics (event-loop lag, memory, GC) → Sentry, mirroring what
      // prom-client's collectDefaultMetrics already exposes for the /metrics scrape.
      Sentry.nodeRuntimeMetricsIntegration(),
    ],
    // Never attach IPs / cookies / user PII automatically.
    sendDefaultPii: false,
    initialScope: { tags: { component: opts.component } },
    // Security-critical: scrub every outgoing event (and breadcrumbs). Error events fire
    // beforeSend; PERFORMANCE transactions fire beforeSendTransaction — a SEPARATE hook,
    // so it must be scrubbed too or auto-instrumented span attributes (request URLs incl.
    // signed resume-token links, SQL text) would ship unscrubbed. scrubEvent/deepScrub is
    // shape-agnostic, so it cleans the transaction's spans[].data / description as well.
    beforeSend: (event) => safeScrub(event) as never,
    beforeSendTransaction: (event) => safeScrub(event) as never,
    // Sentry Logs egress hook — its own path, so scrub it too. pino lines are already
    // scrubbed at the pino hook before forwarding, but a direct Sentry.logger.* call
    // (or the console integration) would otherwise bypass the scrubber.
    beforeSendLog: (log) => safeScrub(log) as never,
    beforeBreadcrumb: (crumb) => safeScrub(crumb) as never,
  });
  enabled = true;
}

export function isSentryEnabled(): boolean {
  return enabled;
}

/** Non-secret context only — tenantId/executionId/nodeId are safe identifiers. */
export interface ErrorContext {
  tenantId?: string;
  executionId?: string;
  nodeId?: string;
  where?: string;
}

/** Report an unexpected error with id-only tags. No-op when Sentry is disabled. */
export function captureError(error: unknown, context: ErrorContext = {}): void {
  if (!enabled) return;
  Sentry.captureException(error, {
    tags: {
      ...(context.tenantId ? { tenantId: context.tenantId } : {}),
      ...(context.executionId ? { executionId: context.executionId } : {}),
      ...(context.nodeId ? { nodeId: context.nodeId } : {}),
      ...(context.where ? { where: context.where } : {}),
    },
  });
}

/**
 * The active span's trace/span ids, for stamping structured logs so a log line can be
 * pivoted to its Sentry trace (and vice-versa). Returns undefined when there's no active
 * span (Sentry off, or outside any traced scope). Safe + cheap to call per log line.
 */
export function getTraceContext():
  { trace_id: string; span_id: string } | undefined {
  const span = Sentry.getActiveSpan();
  if (!span) return undefined;
  const ctx = span.spanContext();
  if (!ctx?.traceId) return undefined;
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

/** Flush buffered events on shutdown (best-effort). */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!enabled) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    /* ignore */
  }
}
