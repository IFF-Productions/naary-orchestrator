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

let enabled = false;

export function initSentry(opts: { component: "api" | "worker" }): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return; // disabled — no DSN configured
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.SENTRY_RELEASE,
    // Opt-in performance tracing; 0 (off) unless explicitly configured.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0"),
    // Never attach IPs / cookies / user PII automatically.
    sendDefaultPii: false,
    initialScope: { tags: { component: opts.component } },
    // Security-critical: scrub every outgoing event (and breadcrumbs).
    beforeSend: (event) =>
      scrubEvent(event as unknown as Record<string, unknown>) as never,
    beforeBreadcrumb: (crumb) =>
      scrubEvent(crumb as unknown as Record<string, unknown>) as never,
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

/** Flush buffered events on shutdown (best-effort). */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!enabled) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    /* ignore */
  }
}
