import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @naary/db so this is a hermetic unit test (no live Postgres needed).
// The real DB write is exercised in slice-2 Task 6's live run. recordUsage upserts
// on (executionId, nodeId) for idempotency, so the mock exposes `upsert`.
const upsert = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ usageEvent: { upsert } }),
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
  upsert.mockReset();
  upsert.mockResolvedValue({ id: "evt_1" });
});

describe("recordUsage", () => {
  it("upserts one UsageEvent with the computed cost and totals", async () => {
    await recordUsage({
      tenantId: "t1",
      executionId: "exec-1",
      nodeId: "agent",
      provider: "anthropic",
      model: "claude-opus-4-8",
      usage: { inputTokens: 1000, outputTokens: 500 },
    });

    expect(upsert).toHaveBeenCalledOnce();
    const arg = upsert.mock.calls[0][0];
    // idempotency: keyed by the (executionId, nodeId) compound unique, no-op update
    expect(arg.where).toEqual({
      executionId_nodeId: { executionId: "exec-1", nodeId: "agent" },
    });
    expect(arg.update).toEqual({});
    const data = arg.create;
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
    const data = upsert.mock.calls[0][0].create;
    expect(Number(String(data.costUsd))).toBeGreaterThan(0);
  });
});
