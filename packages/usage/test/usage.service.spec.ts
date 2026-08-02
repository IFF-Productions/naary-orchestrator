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

  it("tags the ledger row with the run's environmentId when given (Slice 6 cost visibility)", async () => {
    await recordUsage({
      tenantId: "t1",
      environmentId: "e-sandbox",
      executionId: "exec-1",
      nodeId: "agent",
      provider: "anthropic",
      model: "claude-opus-4-8",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(upsert.mock.calls[0][0].create.environmentId).toBe("e-sandbox");
  });

  it("writes environmentId=null for a pre-Slice-6 run (no env) — never undefined", async () => {
    await recordUsage({
      tenantId: "t1",
      executionId: "exec-1",
      nodeId: "agent",
      provider: "anthropic",
      model: "claude-opus-4-8",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(upsert.mock.calls[0][0].create.environmentId).toBeNull();
  });

  it("stamps nodeType + durationMs on the ledger row (Slice 2), rounding sub-ms readings", async () => {
    await recordUsage({
      tenantId: "t1",
      executionId: "exec-1",
      nodeId: "agent",
      nodeType: "agent",
      durationMs: 1840.6,
      provider: "anthropic",
      model: "claude-opus-4-8",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const create = upsert.mock.calls[0][0].create;
    expect(create.nodeType).toBe("agent");
    expect(create.durationMs).toBe(1841); // Int column — rounded, never a float insert
  });

  it("writes nodeType/durationMs as null when the call site doesn't measure (never undefined, never fabricated)", async () => {
    await recordUsage({
      tenantId: "t1",
      executionId: "exec-1",
      nodeId: "agent",
      provider: "anthropic",
      model: "claude-opus-4-8",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const create = upsert.mock.calls[0][0].create;
    expect(create.nodeType).toBeNull();
    expect(create.durationMs).toBeNull();
  });

  it("persists the cache-read + reasoning buckets and bills cache reads at the reduced rate", async () => {
    await recordUsage({
      tenantId: "t1",
      executionId: "exec-1",
      nodeId: "agent",
      provider: "anthropic",
      model: "claude-opus-4-8",
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        cachedInputTokens: 2000,
        reasoningTokens: 300,
      },
    });

    const data = upsert.mock.calls[0][0].create;
    // both detail buckets are written to the ledger (privacy: tokens only, no text)
    expect(data.cachedInputTokens).toBe(2000);
    expect(data.reasoningTokens).toBe(300);
    // cache reads price at 0.5/MTok (opus), a separate bucket from full-rate input:
    //   1000·5 + 2000·0.5 + 500·25 (per MTok) = 0.005 + 0.001 + 0.0125
    expect(String(data.costUsd)).toBe("0.018500");
  });

  it("defaults the cache-read + reasoning buckets to zero when the provider omits them", async () => {
    await recordUsage({
      tenantId: "t1",
      executionId: "exec-1",
      nodeId: "agent",
      provider: "anthropic",
      model: "claude-opus-4-8",
      usage: { inputTokens: 1000, outputTokens: 500 },
    });
    const data = upsert.mock.calls[0][0].create;
    expect(data.cachedInputTokens).toBe(0);
    expect(data.reasoningTokens).toBe(0);
  });

  it("FAIL-SAFE: still ledgers tokens (cost 0) for an unpriced provider/model instead of throwing", async () => {
    // Tier-1 §6: a missing pricing row must not fail the run after the model call
    // succeeded — that would kill the node AND leave the paid call unrecorded.
    // (This is exactly how every codeAgent run died when `claude-code` had no pricing key.)
    await recordUsage({
      tenantId: "t1",
      executionId: "exec-1",
      nodeId: "codeAgent",
      provider: "no-such-provider",
      model: "mystery-model",
      usage: { inputTokens: 1000, outputTokens: 500 },
    });
    expect(upsert).toHaveBeenCalledOnce();
    const data = upsert.mock.calls[0][0].create;
    expect(data.inputTokens).toBe(1000); // tokens ledgered regardless
    expect(String(data.costUsd)).toBe("0.000000"); // unpriced → auditable zero cost
  });

  // ---- #1060: the ledger row remembers whether its TOKENS were measured or estimated ----

  it("persists estimated=true when the caller says the tokens are a rule-6 estimate", async () => {
    await recordUsage({
      tenantId: "t1",
      executionId: "exec-1",
      nodeId: "agent",
      provider: "anthropic",
      model: "claude-opus-4-8",
      usage: { inputTokens: 1000, outputTokens: 500 },
      estimated: true,
    });
    const data = upsert.mock.calls[0][0].create;
    expect(data.estimated).toBe(true);
    // …and the numbers are ledgered exactly as given. The flag QUALIFIES the tokens, it never
    // discounts them: an estimate still bills, which is the whole point of rule 6.
    expect(data.inputTokens).toBe(1000);
    expect(data.outputTokens).toBe(500);
  });

  it("persists estimated=false for a measured call — and for a caller that omits the field", async () => {
    for (const estimated of [false, undefined]) {
      upsert.mockReset();
      upsert.mockResolvedValue({ id: "evt_1" });
      await recordUsage({
        tenantId: "t1",
        executionId: "exec-1",
        nodeId: "agent",
        provider: "anthropic",
        model: "claude-opus-4-8",
        usage: { inputTokens: 10, outputTokens: 5 },
        ...(estimated === undefined ? {} : { estimated }),
      });
      // NOT NULL column: `false`, never undefined — an undefined would let Prisma fall back to the
      // DB default and make the write's meaning depend on the schema rather than on this function.
      expect(upsert.mock.calls[0][0].create.estimated).toBe(false);
    }
  });

  it("does NOT infer `estimated` from the numbers — a zero-cost measured call stays measured", async () => {
    // The tempting shortcut is `estimated = costUsd === 0` or "did the caller pass round numbers".
    // Both are wrong: an unpriced model bills a REAL call at 0 (the fail-safe above), and an
    // estimate is numerically indistinguishable from a measurement. Only the caller knows.
    await recordUsage({
      tenantId: "t1",
      executionId: "exec-1",
      nodeId: "codeAgent",
      provider: "no-such-provider",
      model: "mystery-model",
      usage: { inputTokens: 1000, outputTokens: 500 },
      estimated: false,
    });
    const data = upsert.mock.calls[0][0].create;
    expect(String(data.costUsd)).toBe("0.000000");
    expect(data.estimated).toBe(false);
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
