import { describe, expect, it } from "vitest";
import { counter, histogram, registry, renderMetrics } from "../src/index";

describe("metrics", () => {
  it("renders a registered counter in Prometheus exposition format", async () => {
    const c = counter({
      name: "naary_test_total",
      help: "test counter",
      labelNames: ["outcome"],
    });
    c.inc({ outcome: "ok" });
    c.inc({ outcome: "ok" });
    c.inc({ outcome: "fail" });

    const text = await renderMetrics();
    expect(text).toContain("# TYPE naary_test_total counter");
    expect(text).toContain('naary_test_total{outcome="ok"} 2');
    expect(text).toContain('naary_test_total{outcome="fail"} 1');
  });

  it("records histogram observations (value form AND labels+value form)", async () => {
    const h = histogram({
      name: "naary_test_duration_seconds",
      help: "test histogram",
      labelNames: ["activity"],
    });
    // Both call shapes must still reach Prometheus after the Sentry dual-emit wrap.
    h.observe(0.5);
    h.observe({ activity: "callAgent" }, 1.5);
    const text = await renderMetrics();
    expect(text).toContain("naary_test_duration_seconds_count 1"); // the no-label series
    expect(text).toContain(
      'naary_test_duration_seconds_count{activity="callAgent"} 1',
    );
  });

  it("metrics register to the shared registry", () => {
    expect(registry.getSingleMetric("naary_test_total")).toBeDefined();
  });
});
