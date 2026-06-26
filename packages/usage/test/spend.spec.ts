import { beforeEach, describe, expect, it, vi } from "vitest";

const aggregate = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ usageEvent: { aggregate } }),
}));

import { estimateCallCost, monthToDateSpend } from "../src/spend";

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
