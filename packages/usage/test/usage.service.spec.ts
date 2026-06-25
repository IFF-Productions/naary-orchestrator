import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @naary/db so this is a hermetic unit test (no live Postgres needed).
// The real DB write is exercised in slice-2 Task 6's live run.
const create = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ usageEvent: { create } }),
  Prisma: {
    Decimal: class {
      constructor(public value: string) {}
      toString() {
        return this.value;
      }
    },
  },
}));

import { recordUsage } from "../src/usage.service";

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({ id: "evt_1" });
});

describe("recordUsage", () => {
  it("inserts one UsageEvent with the computed cost and totals", async () => {
    await recordUsage({
      tenantId: "t1",
      executionId: "exec-1",
      nodeId: "agent",
      provider: "anthropic",
      model: "claude-opus-4-8",
      usage: { inputTokens: 1000, outputTokens: 500 },
    });

    expect(create).toHaveBeenCalledOnce();
    const { data } = create.mock.calls[0][0];
    expect(data.tenantId).toBe("t1");
    expect(data.inputTokens).toBe(1000);
    expect(data.outputTokens).toBe(500);
    expect(data.totalTokens).toBe(1500); // defaulted from input+output
    expect(String(data.costUsd)).toBe("0.017500"); // 0.005 + 0.0125, Decimal(12,6)
  });

  it("never records zero for a real call (fallback estimate is non-zero)", async () => {
    await recordUsage({
      tenantId: "t1",
      executionId: "exec-1",
      nodeId: "agent",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      usage: { inputTokens: 50, outputTokens: 20 },
    });
    const { data } = create.mock.calls[0][0];
    expect(Number(String(data.costUsd))).toBeGreaterThan(0);
  });
});
