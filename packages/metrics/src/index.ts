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

export function counter<T extends string = string>(
  cfg: Omit<CounterConfiguration<T>, "registers">,
): Counter<T> {
  return new Counter({ ...cfg, registers: [registry] });
}

export function histogram<T extends string = string>(
  cfg: Omit<HistogramConfiguration<T>, "registers">,
): Histogram<T> {
  return new Histogram({ ...cfg, registers: [registry] });
}

export function gauge<T extends string = string>(
  cfg: Omit<GaugeConfiguration<T>, "registers">,
): Gauge<T> {
  return new Gauge({ ...cfg, registers: [registry] });
}

/** The Prometheus exposition text for the /metrics endpoint. */
export function renderMetrics(): Promise<string> {
  return registry.metrics();
}

/** Content-Type for the /metrics response. */
export const metricsContentType = registry.contentType;
