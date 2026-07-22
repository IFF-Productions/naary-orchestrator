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
import type { SpanAttrs } from "./spans";

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
  initOtlp,
  isOtlpEnabled,
  shutdownOtlp,
  otlpCount,
  otlpDistribution,
  otlpGauge,
} from "./otlp";
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

/**
 * The default integration set, plus — when profiling is opted into — the node profiler.
 * `@sentry/profiling-node` is a NATIVE addon (prebuilt binary per platform/libc): load it
 * lazily and guarded, so a platform without a prebuild degrades to "no profiling" instead
 * of crashing the api/worker at boot (observability must never take the product down).
 */
type SentryIntegration = Parameters<typeof Sentry.addIntegration>[0];

function buildIntegrations(profilesSampleRate: number): SentryIntegration[] {
  const integrations: SentryIntegration[] = [
    Sentry.prismaIntegration(),
    Sentry.pinoIntegration(),
    // Node runtime metrics (event-loop lag, memory, GC) → Sentry, mirroring what
    // prom-client's collectDefaultMetrics already exposes for the /metrics scrape.
    Sentry.nodeRuntimeMetricsIntegration(),
  ];
  if (profilesSampleRate > 0) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { nodeProfilingIntegration } =
        require("@sentry/profiling-node") as typeof import("@sentry/profiling-node");
      integrations.push(nodeProfilingIntegration());
    } catch {
      /* no prebuilt profiler binary for this platform — run without profiling */
    }
  }
  return integrations;
}

export function initSentry(opts: { component: "api" | "worker" }): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return; // disabled — no DSN configured
  // Opt-in CPU profiling; 0 (off) unless explicitly configured. Requires tracing on.
  const profilesSampleRate = Number(
    process.env.SENTRY_PROFILES_SAMPLE_RATE ?? "0",
  );
  Sentry.init({
    dsn,
    // Prefer an explicit SENTRY_ENVIRONMENT (the deploy sets it to "production"); fall back to
    // NODE_ENV, then "development". Without this, prod containers (which don't set NODE_ENV=production)
    // reported every event under "development".
    environment:
      process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
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
    integrations: buildIntegrations(profilesSampleRate),
    // Profiling is TRACE-based: a profile is only collected inside a sampled transaction,
    // so this is effectively profilesSampleRate × tracesSampleRate — both must be > 0.
    profilesSampleRate,
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
 * `ApplicationFailure.type` values that are EXPECTED, user-fixable failures — a bad or
 * exhausted tenant credential, an unconfigured integration, a connection needing re-auth.
 * These surface to the USER on the run (that's their fix to make); reporting each one as a
 * Sentry issue would flood the tracker with noise that no operator can act on. Everything
 * else — subprocess crashes, parse errors, provider 5xx, our own bugs — IS operator-relevant.
 */
const EXPECTED_ACTIVITY_FAILURE_TYPES = new Set([
  "AUTH",
  "QUOTA",
  "AUTH_NOT_CONFIGURED",
  "CONNECTION_REAUTH",
]);

/** True when the error is an expected user-fixable activity failure (see above). Duck-typed
 *  on `type` so this package needs no @temporalio import. Exported for unit tests. */
export function isExpectedActivityFailure(err: unknown): boolean {
  const type = (err as { type?: unknown } | null)?.type;
  return typeof type === "string" && EXPECTED_ACTIVITY_FAILURE_TYPES.has(type);
}

/**
 * Report a failed activity (a workflow NODE failure) as a Sentry ISSUE. No-op when Sentry
 * is disabled or the failure is an expected user-fixable one ({@link isExpectedActivityFailure}).
 *
 * SAFE BY CONSTRUCTION: the error captured here is the exact object that propagates into
 * Temporal history — every activity already sanitizes what it throws (generic messages;
 * never argv/prompt/key material), and `beforeSend` scrubs the event again on egress.
 * Fingerprinted by activity + failure type so each (node kind, failure kind) pair groups
 * into ONE issue instead of splintering by message.
 */
export function captureActivityFailure(
  activity: string,
  ids: SpanAttrs,
  err: unknown,
): void {
  if (!enabled) return;
  if (isExpectedActivityFailure(err)) return;
  const type = (err as { type?: unknown } | null)?.type;
  const kind =
    typeof type === "string" && type
      ? type
      : err instanceof Error
        ? err.name
        : "unknown";
  Sentry.captureException(err, {
    tags: { activity, errorType: kind, ...ids },
    fingerprint: ["activity-failure", activity, kind],
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
