import { describe, expect, it } from "vitest";
import { type InsightsEvent, aggregateInsights } from "../src/insights";

// Two UTC days, two envs, three runs (x1 twice), two models; x3 has no workflowKey and no env.
const events: InsightsEvent[] = [
  {
    executionId: "x1",
    environmentId: "prod",
    provider: "anthropic",
    model: "sonnet",
    totalTokens: 100,
    costUsd: 0.1,
    createdAt: "2026-07-16T10:00:00.000Z",
  },
  {
    executionId: "x1",
    environmentId: "prod",
    provider: "anthropic",
    model: "sonnet",
    totalTokens: 50,
    costUsd: 0.05,
    createdAt: "2026-07-16T20:00:00.000Z",
  },
  {
    executionId: "x2",
    environmentId: "sandbox",
    provider: "openai",
    model: "gpt",
    totalTokens: 200,
    costUsd: 0.2,
    createdAt: "2026-07-17T08:00:00.000Z",
  },
  {
    executionId: "x3",
    environmentId: null,
    provider: "anthropic",
    model: "sonnet",
    totalTokens: 10,
    costUsd: 0.01,
    createdAt: "2026-07-17T09:00:00.000Z",
  },
];
const wfByExec = new Map<string, string | null>([
  ["x1", "triage"],
  ["x2", "summarize"],
  // x3 intentionally absent → resolves to null
]);

describe("aggregateInsights", () => {
  const r = aggregateInsights(events, wfByExec, {
    from: "2026-07-01",
    to: "2026-07-31",
  });

  it("echoes the range and computes overall totals", () => {
    expect(r.range).toEqual({ from: "2026-07-01", to: "2026-07-31" });
    expect(r.totals).toEqual({ costUsd: 0.36, totalTokens: 360, calls: 4 });
  });

  it("byDay buckets by UTC day, ascending", () => {
    expect(r.byDay).toEqual([
      { date: "2026-07-16", costUsd: 0.15, totalTokens: 150, calls: 2 },
      { date: "2026-07-17", costUsd: 0.21, totalTokens: 210, calls: 2 },
    ]);
  });

  it("byEnvironment is desc by cost and keeps a null bucket (untagged rows)", () => {
    expect(r.byEnvironment).toEqual([
      { environmentId: "sandbox", costUsd: 0.2, totalTokens: 200, calls: 1 },
      { environmentId: "prod", costUsd: 0.15, totalTokens: 150, calls: 2 },
      { environmentId: null, costUsd: 0.01, totalTokens: 10, calls: 1 },
    ]);
  });

  it("byWorkflow joins via the exec map, desc by cost, null for unmapped runs", () => {
    expect(r.byWorkflow).toEqual([
      { workflowKey: "summarize", costUsd: 0.2, totalTokens: 200, calls: 1 },
      { workflowKey: "triage", costUsd: 0.15, totalTokens: 150, calls: 2 },
      { workflowKey: null, costUsd: 0.01, totalTokens: 10, calls: 1 },
    ]);
  });

  it("byModel groups by provider/model, desc by cost", () => {
    expect(r.byModel).toEqual([
      {
        provider: "openai",
        model: "gpt",
        costUsd: 0.2,
        totalTokens: 200,
        calls: 1,
      },
      {
        provider: "anthropic",
        model: "sonnet",
        costUsd: 0.16,
        totalTokens: 160,
        calls: 3,
      },
    ]);
  });

  it("empty input → zeroed totals and empty buckets", () => {
    const e = aggregateInsights([], new Map());
    expect(e.totals).toEqual({ costUsd: 0, totalTokens: 0, calls: 0 });
    expect(e.byDay).toEqual([]);
    expect(e.byEnvironment).toEqual([]);
    expect(e.byWorkflow).toEqual([]);
    expect(e.byModel).toEqual([]);
    expect(e.range).toEqual({ from: null, to: null });
  });

  it("rounds costs to 6dp (absorbs float drift)", () => {
    const drift = aggregateInsights(
      [
        {
          executionId: "a",
          environmentId: "e",
          provider: "p",
          model: "m",
          totalTokens: 1,
          costUsd: 0.1,
          createdAt: "2026-07-16T00:00:00.000Z",
        },
        {
          executionId: "a",
          environmentId: "e",
          provider: "p",
          model: "m",
          totalTokens: 1,
          costUsd: 0.2,
          createdAt: "2026-07-16T00:00:00.000Z",
        },
      ],
      new Map([["a", "w"]]),
    );
    // 0.1 + 0.2 === 0.30000000000000004 without rounding
    expect(drift.totals.costUsd).toBe(0.3);
    expect(drift.byModel[0].costUsd).toBe(0.3);
  });

  it("accepts Date objects for createdAt (not just ISO strings)", () => {
    const d = aggregateInsights(
      [
        {
          executionId: "a",
          environmentId: null,
          provider: "p",
          model: "m",
          totalTokens: 1,
          costUsd: 0.01,
          createdAt: new Date("2026-07-16T23:59:59.000Z"),
        },
      ],
      new Map(),
    );
    expect(d.byDay[0].date).toBe("2026-07-16");
  });
});
