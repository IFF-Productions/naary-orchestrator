import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ usageEvent: { findMany } }),
}));

import { estimateCallCost, monthToDateSpend } from "../src/spend";

beforeEach(() => findMany.mockReset());

describe("monthToDateSpend", () => {
  it("sums costUsd for the tenant in the current month", async () => {
    findMany.mockResolvedValue([
      { costUsd: "0.0175" },
      { costUsd: "0.0025" },
      { costUsd: "1.5" },
    ]);
    expect(await monthToDateSpend("t1")).toBeCloseTo(1.52, 9);

    // queried with a month-start lower bound
    const where = findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe("t1");
    expect(where.createdAt.gte).toBeInstanceOf(Date);
  });

  it("is 0 for a tenant with no usage", async () => {
    findMany.mockResolvedValue([]);
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
