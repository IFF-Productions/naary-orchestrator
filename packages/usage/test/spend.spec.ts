import { beforeEach, describe, expect, it, vi } from "vitest";

const aggregate = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ usageEvent: { aggregate } }),
}));

import {
  estimateCallCost,
  isOverMonthlyBudget,
  monthToDateSpend,
  monthToDateSpendForTenants,
} from "../src/spend";

beforeEach(() => aggregate.mockReset());

describe("monthToDateSpend", () => {
  it("returns the DB-side sum of costUsd for the current month", async () => {
    aggregate.mockResolvedValue({ _sum: { costUsd: "1.52" } });
    expect(await monthToDateSpend("t1")).toBeCloseTo(1.52, 9);

    // aggregated by tenant + month-start lower bound, summing costUsd in Postgres
    const arg = aggregate.mock.calls[0][0];
    expect(arg.where.tenantId).toBe("t1");
    expect(arg.where.createdAt.gte).toBeInstanceOf(Date);
    expect(arg._sum).toEqual({ costUsd: true });
  });

  it("is 0 for a tenant with no usage (null sum)", async () => {
    aggregate.mockResolvedValue({ _sum: { costUsd: null } });
    expect(await monthToDateSpend("t1")).toBe(0);
  });
});

describe("monthToDateSpendForTenants (company-wide sum)", () => {
  it("returns the DB-side sum over an IN-list of tenants for the current month", async () => {
    aggregate.mockResolvedValue({ _sum: { costUsd: "12.34" } });
    expect(await monthToDateSpendForTenants(["t1", "t2"])).toBeCloseTo(
      12.34,
      9,
    );

    // one aggregate: IN-list of tenants + the same month-start lower bound, summed in Postgres
    const arg = aggregate.mock.calls[0][0];
    expect(arg.where.tenantId).toEqual({ in: ["t1", "t2"] });
    expect(arg.where.createdAt.gte).toBeInstanceOf(Date);
    // UTC month start — the same window as monthToDateSpend (day 1, midnight UTC)
    expect(arg.where.createdAt.gte.getUTCDate()).toBe(1);
    expect(arg.where.createdAt.gte.getUTCHours()).toBe(0);
    expect(arg._sum).toEqual({ costUsd: true });
  });

  it("is 0 for an empty tenant list WITHOUT querying the DB", async () => {
    expect(await monthToDateSpendForTenants([])).toBe(0);
    expect(aggregate).not.toHaveBeenCalled();
  });

  it("is 0 when the tenants have no usage (null sum)", async () => {
    aggregate.mockResolvedValue({ _sum: { costUsd: null } });
    expect(await monthToDateSpendForTenants(["t1"])).toBe(0);
  });
});

describe("isOverMonthlyBudget", () => {
  it("is true only when month-to-date spend meets/exceeds the cap", async () => {
    aggregate.mockResolvedValue({ _sum: { costUsd: "10.00" } });
    expect(await isOverMonthlyBudget("t1", 10)).toBe(true); // at the cap
    expect(await isOverMonthlyBudget("t1", 10.01)).toBe(false); // just under
    expect(await isOverMonthlyBudget("t1", 5)).toBe(true); // over
  });

  it("is false (never gated) when no cap is configured", async () => {
    expect(await isOverMonthlyBudget("t1", undefined)).toBe(false);
    expect(await isOverMonthlyBudget("t1", null)).toBe(false);
    expect(await isOverMonthlyBudget("t1", 0)).toBe(false);
    expect(aggregate).not.toHaveBeenCalled(); // short-circuits before the DB read
  });
});

describe("estimateCallCost", () => {
  const cfg = {
    provider: "anthropic",
    model: "claude-opus-4-8",
    systemPrompt: "classify the message",
  };

  it("is non-zero and priced via the pricing table", () => {
    const est = estimateCallCost(cfg, { message: "hello" });
    expect(est).toBeGreaterThan(0);
    // dominated by the assumed 1024 output tokens on opus ($25/MTok) ≈ 0.0256
    expect(est).toBeGreaterThan(0.025);
  });

  it("estimates a cheaper model lower (used for the downgrade decision)", () => {
    const opus = estimateCallCost(cfg, { message: "hi" });
    const haiku = estimateCallCost(
      { ...cfg, model: "claude-haiku-4-5" },
      { message: "hi" },
    );
    expect(haiku).toBeLessThan(opus);
  });
});
