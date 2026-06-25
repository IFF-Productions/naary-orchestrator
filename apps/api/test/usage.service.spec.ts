import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ usageEvent: { findMany } }),
}));

beforeEach(() => findMany.mockReset());

import { UsageService } from "../src/usage/usage.service";

const row = (over: Partial<Record<string, unknown>>) => ({
  id: "e1",
  executionId: "exec-1",
  nodeId: "agent",
  provider: "anthropic",
  model: "claude-opus-4-8",
  inputTokens: 1000,
  outputTokens: 500,
  totalTokens: 1500,
  costUsd: "0.017500",
  createdAt: new Date("2026-06-25T00:00:00Z"),
  ...over,
});

describe("UsageService.getUsage", () => {
  it("aggregates total cost/tokens and groups by model", async () => {
    findMany.mockResolvedValue([
      row({ id: "e1", costUsd: "0.017500", totalTokens: 1500 }),
      row({
        id: "e2",
        costUsd: "0.002500",
        totalTokens: 700,
        model: "claude-haiku-4-5",
      }),
      row({ id: "e3", costUsd: "0.017500", totalTokens: 1500 }),
    ]);

    const svc = new UsageService();
    const summary = await svc.getUsage("t1");

    expect(summary.totalCostUsd).toBeCloseTo(0.0375, 9);
    expect(summary.totalTokens).toBe(3700);
    expect(summary.events).toHaveLength(3);

    const opus = summary.byModel.find((m) => m.model === "claude-opus-4-8")!;
    expect(opus.calls).toBe(2);
    expect(opus.costUsd).toBeCloseTo(0.035, 9);
    const haiku = summary.byModel.find((m) => m.model === "claude-haiku-4-5")!;
    expect(haiku.calls).toBe(1);
  });

  it("passes a date range filter to the query", async () => {
    findMany.mockResolvedValue([]);
    const svc = new UsageService();
    await svc.getUsage("t1", "2026-06-01", "2026-06-30");

    const where = findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe("t1");
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(where.createdAt.lte).toBeInstanceOf(Date);
  });
});
