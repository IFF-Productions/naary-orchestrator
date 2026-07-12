import { describe, expect, it } from "vitest";
import { metricCount, metricDistribution, metricGauge } from "../src/metrics";

/**
 * With Sentry DISABLED (no client), every metric helper must be a silent no-op — never
 * throw, never require a client. That's the invariant that keeps metrics from ever
 * breaking a caller. Actual ingestion into Sentry needs a live DSN and is verified
 * manually (and depends on the Sentry project/plan).
 */
describe("Sentry metric helpers (no-op when Sentry is off)", () => {
  it("do not throw and return void", () => {
    expect(metricCount("naary.test.count")).toBeUndefined();
    expect(
      metricCount("naary.test.count", 3, { outcome: "ok" }),
    ).toBeUndefined();
    expect(
      metricDistribution("naary.test.dur", 0.5, { activity: "x" }, "second"),
    ).toBeUndefined();
    expect(metricGauge("naary.test.gauge", 42, { pool: "pg" })).toBeUndefined();
  });
});
