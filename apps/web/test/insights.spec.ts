import { describe, expect, it } from "vitest";
import {
  dayBars,
  envLabel,
  insightsQuery,
  rankBuckets,
  usd,
  wfLabel,
  windowFromDate,
  windowLabel,
} from "../src/screens/app/insights.logic";

describe("windowFromDate", () => {
  it("returns the ISO date `days` before `now` (default 30)", () => {
    // 2026-07-31 → 30 days earlier is 2026-07-01.
    const now = Date.parse("2026-07-31T12:00:00.000Z");
    expect(windowFromDate(now)).toBe("2026-07-01");
    expect(windowFromDate(now, 7)).toBe("2026-07-24");
  });
});

describe("dayBars", () => {
  it("maps byDay to {label,value} bars, preserving order", () => {
    expect(
      dayBars([
        { date: "2026-07-01", costUsd: 0.1, totalTokens: 10, calls: 1 },
        { date: "2026-07-02", costUsd: 0.25, totalTokens: 20, calls: 2 },
      ]),
    ).toEqual([
      { label: "2026-07-01", value: 0.1 },
      { label: "2026-07-02", value: 0.25 },
    ]);
  });
});

describe("rankBuckets", () => {
  const rows = [
    { environmentId: "prod", costUsd: 0.1, totalTokens: 1, calls: 1 },
    { environmentId: "sandbox", costUsd: 0.4, totalTokens: 1, calls: 3 },
    { environmentId: null, costUsd: 0.2, totalTokens: 1, calls: 1 },
  ];

  it("sorts desc by cost and scales each bar to the max (100%)", () => {
    const out = rankBuckets(rows, (r) => envLabel(r.environmentId));
    expect(out.map((r) => r.label)).toEqual(["sandbox", "— untagged", "prod"]);
    expect(out[0].pct).toBe(100); // the largest
    expect(out[1].pct).toBe(50); // 0.2 / 0.4
    expect(out[2].pct).toBe(25); // 0.1 / 0.4
    expect(out[0].calls).toBe(3);
  });

  it("labels a null bucket instead of dropping it", () => {
    const out = rankBuckets(rows, (r) => envLabel(r.environmentId));
    expect(out.map((r) => r.label)).toContain("— untagged");
  });

  it("truncates to the top n", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      costUsd: i,
      calls: 1,
      workflowKey: `w${i}`,
    }));
    const out = rankBuckets(many, (r) => wfLabel(r.workflowKey), 8);
    expect(out).toHaveLength(8);
    expect(out[0].label).toBe("w11"); // highest cost first
  });

  it("empty input → empty (no NaN pct from a zero max)", () => {
    expect(
      rankBuckets([], (r) => envLabel((r as never)["environmentId"])),
    ).toEqual([]);
  });
});

describe("insightsQuery", () => {
  const now = Date.parse("2026-07-31T12:00:00.000Z");

  it("30d window → from set, no environmentId", () => {
    expect(insightsQuery(now, 30, null)).toEqual({ from: "2026-07-01" });
  });

  it("all time (days null) → empty query (no from)", () => {
    expect(insightsQuery(now, null, null)).toEqual({});
  });

  it("includes environmentId when selected", () => {
    expect(insightsQuery(now, 7, "env-prod")).toEqual({
      from: "2026-07-24",
      environmentId: "env-prod",
    });
  });

  it("all time + an environment → only environmentId", () => {
    expect(insightsQuery(now, null, "env-prod")).toEqual({
      environmentId: "env-prod",
    });
  });
});

describe("windowLabel", () => {
  it("describes the selected window", () => {
    expect(windowLabel(30)).toBe("last 30 days");
    expect(windowLabel(null)).toBe("all time");
  });
});

describe("usd", () => {
  it("uses up to 4dp for sub-$1 amounts, 2dp otherwise", () => {
    expect(usd(0.0142)).toBe("$0.0142");
    expect(usd(12.5)).toBe("$12.50");
    expect(usd(0)).toBe("$0.00");
  });
});
