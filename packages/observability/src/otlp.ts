/**
 * Domain metrics → OTLP (OpenTelemetry Protocol) sink, e.g. Datadog via its OTLP
 * intake (#462). OFF unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set — mirroring the
 * Sentry-off-unless-SENTRY_DSN pattern, so an unconfigured deployment is
 * byte-identical to today: no MeterProvider, no exporter, no network, no cost.
 *
 * These are additive to Prometheus (@naary/metrics) + Sentry (metrics.ts) — the same
 * counter/histogram/gauge observations are dual-emitted here when configured. The
 * OTel metrics SDK is pure JS with no import-time side effects, so it's imported
 * statically; only CONSTRUCTION is gated on the env var.
 *
 * SECURITY: attributes are low-cardinality dimensions (method/status/activity/…),
 * but the CLAUDE.md rule is "secrets never enter telemetry" — so every attribute set
 * is run through the shared {@link deepScrub} on egress before it reaches the exporter.
 * The OTLP auth header (OTEL_EXPORTER_OTLP_HEADERS, e.g. DD-API-KEY) is transport
 * config, not metric DATA — the SDK reads it from env; we never scrub or log it.
 *
 * DETERMINISM: never call from workflow code; activities + API only.
 */
import {
  type Counter,
  type Gauge,
  type Histogram,
  metrics as otelMetrics,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  type MeterProvider as MeterProviderType,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import type { MetricAttributes } from "./metrics";
import { deepScrub } from "./scrub";

let provider: MeterProviderType | undefined;
let meter: ReturnType<typeof otelMetrics.getMeter> | undefined;

// Instruments are created lazily on first use and cached by name (the OTel API
// returns the same instrument for a repeated name, but caching avoids the lookup).
const counters = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();
const gauges = new Map<string, Gauge>();

function active(): boolean {
  return meter !== undefined;
}

/**
 * Scrub attributes on egress (defense in depth — labels are meant to be id-free, but
 * a secret must never leave even by mistake). deepScrub mutates in place, so operate
 * on a shallow clone to avoid touching the caller's object; OTel wants a flat
 * string→primitive map, which the clone already is.
 */
function scrubAttrs(
  attributes?: MetricAttributes,
): MetricAttributes | undefined {
  if (!attributes) return undefined;
  return deepScrub({ ...attributes });
}

/**
 * Wire the OTLP metric exporter. No-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
 * Endpoint + headers are read from the standard `OTEL_EXPORTER_OTLP_*` env vars by
 * the exporter itself. Fully guarded: a construction failure degrades to "no OTLP"
 * rather than taking the process down (observability must never break the product).
 */
export function initOtlp(opts: { component: "api" | "worker" }): void {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return; // disabled — not configured
  try {
    const exporter = new OTLPMetricExporter();
    const reader = new PeriodicExportingMetricReader({ exporter });
    provider = new MeterProvider({
      resource: resourceFromAttributes({
        "service.name": `naary-${opts.component}`,
        "service.namespace": "naary",
      }),
      readers: [reader],
    });
    meter = provider.getMeter("naary");
  } catch {
    // SDK missing / misconfigured — leave OTLP off. Never throw at boot.
    provider = undefined;
    meter = undefined;
  }
}

/** True when the OTLP exporter is wired (endpoint configured + construction succeeded). */
export function isOtlpEnabled(): boolean {
  return active();
}

/** Increment a counter metric on the OTLP sink (default +1). No-op when disabled. */
export function otlpCount(
  name: string,
  value = 1,
  attributes?: MetricAttributes,
): void {
  if (!meter) return;
  try {
    let c = counters.get(name);
    if (!c) {
      c = meter.createCounter(name);
      counters.set(name, c);
    }
    c.add(value, scrubAttrs(attributes));
  } catch {
    /* metrics must never break the caller */
  }
}

/** Record a distribution (e.g. a duration) on the OTLP sink. No-op when disabled. */
export function otlpDistribution(
  name: string,
  value: number,
  attributes?: MetricAttributes,
  unit?: string,
): void {
  if (!meter) return;
  try {
    let h = histograms.get(name);
    if (!h) {
      h = meter.createHistogram(name, unit ? { unit } : undefined);
      histograms.set(name, h);
    }
    h.record(value, scrubAttrs(attributes));
  } catch {
    /* metrics must never break the caller */
  }
}

/** Set a gauge metric on the OTLP sink. No-op when disabled. */
export function otlpGauge(
  name: string,
  value: number,
  attributes?: MetricAttributes,
  unit?: string,
): void {
  if (!meter) return;
  try {
    let g = gauges.get(name);
    if (!g) {
      g = meter.createGauge(name, unit ? { unit } : undefined);
      gauges.set(name, g);
    }
    g.record(value, scrubAttrs(attributes));
  } catch {
    /* metrics must never break the caller */
  }
}

/**
 * Flush + tear down the OTLP exporter on shutdown. PeriodicExportingMetricReader
 * batches on an interval (~60s), so a worker/api exiting without this loses buffered
 * metrics. Best-effort — a shutdown must never throw.
 */
export async function shutdownOtlp(): Promise<void> {
  const p = provider;
  if (!p) return;
  provider = undefined;
  meter = undefined;
  counters.clear();
  histograms.clear();
  gauges.clear();
  try {
    await p.shutdown();
  } catch {
    /* ignore */
  }
}

/** Test-only: reset module state so cases don't leak the exporter between runs. */
export function __resetOtlpForTest(): void {
  provider = undefined;
  meter = undefined;
  counters.clear();
  histograms.clear();
  gauges.clear();
}
