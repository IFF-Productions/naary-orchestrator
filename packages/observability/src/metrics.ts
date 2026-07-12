/**
 * Domain metrics → Sentry. Thin, guarded wrappers over Sentry's metrics API, OFF unless
 * Sentry is initialized (SENTRY_DSN set). Every call is best-effort: a metric must NEVER
 * break the caller, so emission is wrapped in try/catch and no-ops when Sentry is off.
 *
 * These are additive to the Prometheus metrics (@naary/metrics) — that package forwards
 * every counter/histogram observation here too, so the same domain metrics land in both
 * the /metrics scrape AND Sentry. NOTE: whether Sentry actually INGESTS metrics depends
 * on the Sentry project/plan; the SDK accepts the calls regardless.
 *
 * SECURITY: attributes are low-cardinality dimensions only (method/status/activity/
 * outcome/workflowKey) — never tenant or run ids. DETERMINISM: never call from workflow
 * code; activities + API only.
 */
import * as Sentry from "@sentry/node";

/** Low-cardinality metric dimensions. Never tenant/run ids. */
export type MetricAttributes = Record<string, string | number | boolean>;

function active(): boolean {
  return Sentry.getClient() !== undefined;
}

function opts(attributes?: MetricAttributes, unit?: string) {
  if (!attributes && !unit) return undefined;
  return {
    ...(attributes ? { attributes } : {}),
    ...(unit ? { unit } : {}),
  };
}

/** Increment a counter metric (default +1). */
export function metricCount(
  name: string,
  value = 1,
  attributes?: MetricAttributes,
): void {
  if (!active()) return;
  try {
    Sentry.metrics.count(name, value, opts(attributes));
  } catch {
    /* metrics must never break the caller */
  }
}

/** Record a value in a distribution metric (e.g. a duration). */
export function metricDistribution(
  name: string,
  value: number,
  attributes?: MetricAttributes,
  unit?: string,
): void {
  if (!active()) return;
  try {
    Sentry.metrics.distribution(name, value, opts(attributes, unit));
  } catch {
    /* metrics must never break the caller */
  }
}

/** Set a gauge metric to a value. */
export function metricGauge(
  name: string,
  value: number,
  attributes?: MetricAttributes,
  unit?: string,
): void {
  if (!active()) return;
  try {
    Sentry.metrics.gauge(name, value, opts(attributes, unit));
  } catch {
    /* metrics must never break the caller */
  }
}
