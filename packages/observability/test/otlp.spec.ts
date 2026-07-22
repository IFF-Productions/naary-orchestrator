import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetOtlpForTest,
  initOtlp,
  isOtlpEnabled,
  otlpCount,
  otlpDistribution,
  otlpGauge,
} from "../src/otlp";

/**
 * #462 off-by-default proof. These exercise the REAL OTel SDK (no mocked
 * constructor) so the test fails loudly if the exporter/reader/provider chain
 * can't load or construct under swc — the exact silent-swallow trap we must catch.
 */
describe("otlp metrics exporter", () => {
  const prev = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  beforeEach(() => {
    __resetOtlpForTest();
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = prev;
    __resetOtlpForTest();
  });

  it("is OFF and a no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset", () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    initOtlp({ component: "worker" });
    expect(isOtlpEnabled()).toBe(false);
    // No exporter constructed → emissions are pure no-ops (must never throw).
    expect(() =>
      otlpCount("naary_test_total", 1, { outcome: "ok" }),
    ).not.toThrow();
    expect(() =>
      otlpDistribution("naary_test_seconds", 0.5, { activity: "x" }, "second"),
    ).not.toThrow();
    expect(() => otlpGauge("naary_test_gauge", 3)).not.toThrow();
  });

  it("IS wired when OTEL_EXPORTER_OTLP_ENDPOINT is set (real SDK constructs)", () => {
    // A bogus endpoint is fine: PeriodicExportingMetricReader batches on an interval
    // and won't flush during the test, so no network is hit.
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
    initOtlp({ component: "worker" });
    // isOtlpEnabled()===true is end-to-end proof the whole construction chain
    // (exporter → reader → MeterProvider → meter) succeeded.
    expect(isOtlpEnabled()).toBe(true);
    expect(() =>
      otlpCount("naary_test_total", 2, { outcome: "ok" }),
    ).not.toThrow();
    expect(() =>
      otlpDistribution("naary_test_seconds", 1.5, { activity: "x" }, "second"),
    ).not.toThrow();
    expect(() => otlpGauge("naary_test_gauge", 7)).not.toThrow();
  });
});
