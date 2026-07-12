/**
 * Prometheus metrics shared by the API + worker (PRODUCTION-READINESS §3.D).
 * One process-wide registry; each app defines the metrics it cares about via the
 * factories below (which attach to that registry), and exposes them at /metrics.
 *
 * No secrets ever go in metric labels — only low-cardinality identifiers
 * (component, method, status, activity, outcome). Tenant/run ids are NOT labels
 * (they'd explode cardinality and leak ids into a scrape target).
 */
import {
  metricCount,
  metricDistribution,
  metricGauge,
} from "@naary/observability";
import {
  Counter,
  type CounterConfiguration,
  Gauge,
  type GaugeConfiguration,
  Histogram,
  type HistogramConfiguration,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

// Re-export the metric types so consumer packages can annotate their exported
// metrics (prom-client lives in THIS package's node_modules, so an inferred type
// isn't portably nameable from a consumer — TS2883).
export type { Counter, Gauge, Histogram } from "prom-client";

/** The single registry all app metrics register to. */
export const registry = new Registry();

/** Call once at boot: tag every series with the component + collect Node/process
 *  metrics (event loop lag, memory, GC, …). */
export function initMetrics(opts: { component: "api" | "worker" }): void {
  registry.setDefaultLabels({ component: opts.component });
  collectDefaultMetrics({ register: registry });
}

/** Prometheus metric methods take either (value) or (labels, value). Split them into the
 *  (attributes, value) shape Sentry wants. Labels are already low-cardinality (no ids). */
function split(
  a0: unknown,
  a1: unknown,
  fallback: number,
): { attributes?: Record<string, string>; value: number } {
  if (typeof a0 === "number") return { value: a0 };
  if (a0 && typeof a0 === "object") {
    const attributes: Record<string, string> = {};
    for (const [k, v] of Object.entries(a0 as Record<string, unknown>)) {
      attributes[k] = String(v);
    }
    return { attributes, value: typeof a1 === "number" ? a1 : fallback };
  }
  return { value: fallback };
}

/** A Prometheus unit hint from the metric name suffix, for the Sentry distribution. */
function unitFromName(name: string): string | undefined {
  if (name.endsWith("_seconds")) return "second";
  if (name.endsWith("_bytes")) return "byte";
  if (name.endsWith("_milliseconds")) return "millisecond";
  return undefined;
}

export function counter<T extends string = string>(
  cfg: Omit<CounterConfiguration<T>, "registers">,
): Counter<T> {
  const c = new Counter({ ...cfg, registers: [registry] });
  const inc = c.inc.bind(c);
  // Record to Prometheus (unchanged), THEN best-effort mirror to Sentry. The original
  // fires first + the forward is fully guarded, so metrics can never break a caller.
  c.inc = ((a0?: unknown, a1?: unknown) => {
    inc(a0 as never, a1 as never);
    const { attributes, value } = split(a0, a1, 1);
    metricCount(cfg.name, value, attributes);
  }) as Counter<T>["inc"];
  return c;
}

export function histogram<T extends string = string>(
  cfg: Omit<HistogramConfiguration<T>, "registers">,
): Histogram<T> {
  const h = new Histogram({ ...cfg, registers: [registry] });
  const observe = h.observe.bind(h);
  const unit = unitFromName(cfg.name);
  h.observe = ((a0?: unknown, a1?: unknown) => {
    observe(a0 as never, a1 as never);
    const { attributes, value } = split(a0, a1, 0);
    metricDistribution(cfg.name, value, attributes, unit);
  }) as Histogram<T>["observe"];
  return h;
}

export function gauge<T extends string = string>(
  cfg: Omit<GaugeConfiguration<T>, "registers">,
): Gauge<T> {
  const g = new Gauge({ ...cfg, registers: [registry] });
  const set = g.set.bind(g);
  const unit = unitFromName(cfg.name);
  g.set = ((a0?: unknown, a1?: unknown) => {
    set(a0 as never, a1 as never);
    const { attributes, value } = split(a0, a1, 0);
    metricGauge(cfg.name, value, attributes, unit);
  }) as Gauge<T>["set"];
  return g;
}

/** The Prometheus exposition text for the /metrics endpoint. */
export function renderMetrics(): Promise<string> {
  return registry.metrics();
}

/** Content-Type for the /metrics response. */
export const metricsContentType = registry.contentType;
