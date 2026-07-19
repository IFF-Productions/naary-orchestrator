import { describe, expect, it } from "vitest";
import type { BudgetView, UsageEventItem } from "../src/lib/api";
import {
  ALERT_PCT,
  budgetHealth,
  budgetStoppedThisMonth,
  earliestEventDate,
  enforcementLadder,
  fmtTokens,
  monthWindow,
  parseUsageEvents,
  projectMonthly,
  spendPct,
  stackSpendByDay,
} from "../src/screens/app/billing/billing-model";

const budget = (over: Partial<BudgetView> = {}): BudgetView => ({
  tenantId: "t1",
  monthlyCapUsd: 400,
  perExecutionCapUsd: 0.5,
  maxStepsPerRun: 50,
  onBudgetExceeded: "reject",
  fallbackModel: null,
  mtdSpendUsd: 100,
  remainingUsd: 300,
  ...over,
});

describe("monthWindow", () => {
  it("spans the UTC calendar month and counts elapsed/left days", () => {
    const now = Date.parse("2026-07-19T12:00:00.000Z");
    const w = monthWindow(now);
    expect(w.fromISO).toBe("2026-07-01");
    expect(w.label).toBe("Jul 1–31");
    expect(w.daysInMonth).toBe(31);
    expect(w.daysLeft).toBe(12);
    expect(w.elapsedDays).toBeCloseTo(18.5, 1);
  });
});

describe("projectMonthly", () => {
  it("is linear: mtd ÷ elapsed × daysInMonth", () => {
    const w = monthWindow(Date.parse("2026-07-16T00:00:00.000Z")); // 15 days elapsed
    expect(projectMonthly(150, w)).toBeCloseTo((150 / 15) * 31, 5);
  });
});

describe("budgetHealth / spendPct", () => {
  it("maps real % to the four presentation states", () => {
    expect(budgetHealth(10)).toBe("healthy");
    expect(budgetHealth(ALERT_PCT)).toBe("alert");
    expect(budgetHealth(90)).toBe("near");
    expect(budgetHealth(120)).toBe("over");
  });
  it("spendPct divides mtd by the cap (0 for a 0 cap)", () => {
    expect(spendPct(budget({ mtdSpendUsd: 100, monthlyCapUsd: 400 }))).toBe(25);
    expect(spendPct(budget({ monthlyCapUsd: 0 }))).toBe(0);
  });
});

describe("enforcementLadder", () => {
  it("reject policy: one 100% reject rung + the two per-run guards", () => {
    const rungs = enforcementLadder(budget(), 40);
    expect(rungs.map((r) => r.title)).toEqual([
      "Reject over cap",
      "Per-run cap",
      "Step limit / run",
    ]);
    expect(rungs[0].active).toBe(false);
    expect(rungs[1].at).toBe("$0.50");
    expect(rungs[2].at).toBe("50");
  });
  it("downgrade policy swaps the monthly rung and lights it past 100%", () => {
    const rungs = enforcementLadder(
      budget({ onBudgetExceeded: "downgrade", fallbackModel: "haiku" }),
      104,
    );
    expect(rungs[0].title).toBe("Downgrade");
    expect(rungs[0].desc).toContain("haiku");
    expect(rungs[0].active).toBe(true);
  });
});

describe("budgetStoppedThisMonth", () => {
  it("counts only budget_exceeded runs created this billing month", () => {
    const now = Date.parse("2026-07-19T12:00:00.000Z");
    const w = monthWindow(now);
    const mk = (status: string, createdAt: string) =>
      ({ status, createdAt }) as never;
    const rows = budgetStoppedThisMonth(
      [
        mk("budget_exceeded", "2026-07-18T00:00:00Z"),
        mk("budget_exceeded", "2026-06-28T00:00:00Z"), // previous month
        mk("failed", "2026-07-18T00:00:00Z"),
      ],
      w,
    );
    expect(rows).toHaveLength(1);
  });
});

describe("parseUsageEvents", () => {
  it("keeps only well-formed line items", () => {
    const good = {
      id: "1",
      executionId: "r1",
      nodeId: "n1",
      provider: "anthropic",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      costUsd: 0.1,
      createdAt: "2026-07-01T00:00:00Z",
    };
    expect(parseUsageEvents([good, null, {}, "x"])).toEqual([good]);
  });
});

describe("stackSpendByDay", () => {
  const ev = (model: string, day: string, cost: number): UsageEventItem => ({
    id: `${model}-${day}`,
    executionId: "r",
    nodeId: "n",
    provider: "p",
    model,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: cost,
    createdAt: `${day}T10:00:00.000Z`,
  });

  it("stacks by ranked model with quiet days present", () => {
    const now = Date.parse("2026-07-03T12:00:00.000Z");
    const { series, days, max } = stackSpendByDay(
      [
        ev("a", "2026-07-01", 3),
        ev("b", "2026-07-01", 1),
        ev("a", "2026-07-03", 2),
      ],
      [
        { provider: "p", model: "a" },
        { provider: "p", model: "b" },
      ],
      "2026-07-01",
      now,
    );
    expect(series.map((s) => s.label)).toEqual(["a", "b"]);
    expect(days.map((d) => d.total)).toEqual([4, 0, 2]);
    expect(days[0].parts).toEqual([3, 1]);
    expect(max).toBe(4);
  });

  it("folds models beyond the slot count into Other", () => {
    const now = Date.parse("2026-07-01T12:00:00.000Z");
    const ranking = ["a", "b", "c", "d", "e"].map((m) => ({
      provider: "p",
      model: m,
    }));
    const { series, days } = stackSpendByDay(
      [ev("e", "2026-07-01", 1), ev("a", "2026-07-01", 5)],
      ranking,
      "2026-07-01",
      now,
    );
    expect(series.map((s) => s.label)).toEqual(["a", "b", "c", "d", "Other"]);
    expect(days[0].parts).toEqual([5, 0, 0, 0, 1]);
  });
});

describe("earliestEventDate / fmtTokens", () => {
  it("finds the earliest ledger date, falling back to today", () => {
    const now = Date.parse("2026-07-19T00:00:00.000Z");
    expect(
      earliestEventDate(
        [
          { createdAt: "2026-06-02T05:00:00Z" } as UsageEventItem,
          { createdAt: "2026-07-01T05:00:00Z" } as UsageEventItem,
        ],
        now,
      ),
    ).toBe("2026-06-02");
    expect(earliestEventDate([], now)).toBe("2026-07-19");
  });
  it("formats token counts compactly", () => {
    expect(fmtTokens(950)).toBe("950");
    expect(fmtTokens(18_200_000)).toBe("18.2M");
    expect(fmtTokens(1_100_000_000)).toBe("1.1B");
    expect(fmtTokens(1_500)).toBe("1.5k");
  });
});
