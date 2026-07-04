import { APICallError } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeCost } from "@naary/usage";
import { MissingCredentialError } from "@naary/secrets";

// Mock only the model network. Credentials + usage are injected via the
// activity's test seam, so this test is hermetic (no DB, no LLM).
const generateText = vi.fn();
vi.mock("ai", async (orig) => ({
  ...(await orig<typeof import("ai")>()),
  generateText: (...args: unknown[]) => generateText(...args),
}));

import { __agentDeps, runAgent } from "../src/temporal/activities";

const META = { tenantId: "t1", executionId: "exec-1", nodeId: "agent" };
const CFG = {
  provider: "anthropic",
  model: "claude-opus-4-8",
  systemPrompt: "classify",
};
const SEED_KEY = "tenant-anthropic-key-value";

const recordUsage = vi.fn();
let getKey: () => Promise<string>;
let getBudget: () => Promise<unknown>;
let mtdSpend = 0;
const reserveBudget = vi.fn();
const releaseReservation = vi.fn();

beforeEach(() => {
  generateText.mockReset();
  recordUsage.mockReset().mockResolvedValue({ id: "evt_1" });
  getKey = () => Promise.resolve(SEED_KEY);
  getBudget = () => Promise.resolve(null); // no budget ⇒ no enforcement by default
  mtdSpend = 0;
  // default: reservation succeeds (each budget test overrides as needed)
  reserveBudget.mockReset().mockResolvedValue({ ok: true, id: "res_1" });
  releaseReservation.mockReset().mockResolvedValue(undefined);
  __agentDeps.getCredentials = () =>
    ({ getDecryptedKey: () => getKey() }) as never;
  __agentDeps.recordUsage = recordUsage as never;
  __agentDeps.getBudget = (() => getBudget()) as never;
  __agentDeps.monthToDateSpend = (() => Promise.resolve(mtdSpend)) as never;
  __agentDeps.reserveBudget = reserveBudget as never;
  __agentDeps.releaseReservation = releaseReservation as never;
});

afterEach(() => vi.clearAllMocks());

describe("runAgent", () => {
  it("returns structured output and records ONE usage event with real provider usage", async () => {
    generateText.mockResolvedValue({
      output: { category: "billing", urgency: 4 },
      text: '{"category":"billing","urgency":4}',
      totalUsage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    });

    const result = await runAgent(CFG, { msg: "double charged" }, META);

    expect(result).toMatchObject({
      status: "ok",
      output: { category: "billing", urgency: 4 },
      model: "claude-opus-4-8",
    });
    // returns its own cost for the workflow to accumulate (Task 3)
    expect(result.costUsd).toBeCloseTo(0.0175, 9);
    expect(recordUsage).toHaveBeenCalledOnce();
    const recorded = recordUsage.mock.calls[0][0];
    expect(recorded.usage.inputTokens).toBe(1000);
    expect(recorded.usage.outputTokens).toBe(500);
    // the captured tokens price to a real, non-zero cost
    expect(
      computeCost({
        provider: "anthropic",
        model: CFG.model,
        ...recorded.usage,
      }),
    ).toBeCloseTo(0.0175, 9);
  });

  it("maps ai@7 nested usage details to the cache-read + reasoning ledger buckets", async () => {
    // ai@7 moved cache-read + reasoning counts out of the flat usage object into
    // inputTokenDetails/outputTokenDetails. runAgent must remap them so the ledger
    // still records the cache-read bucket AND bills it at the reduced cache rate —
    // a wrong path would silently record 0 cached tokens and over-bill cache reads
    // at the full input rate.
    generateText.mockResolvedValue({
      output: { category: "billing", urgency: 4 },
      text: '{"category":"billing","urgency":4}',
      totalUsage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        inputTokenDetails: { cacheReadTokens: 2000 },
        outputTokenDetails: { reasoningTokens: 300 },
      },
    });

    const result = await runAgent(CFG, { msg: "cached prompt" }, META);

    expect(recordUsage).toHaveBeenCalledOnce();
    const recorded = recordUsage.mock.calls[0][0];
    // nested ai@7 details land in the flat ledger buckets recordUsage persists
    expect(recorded.usage.cachedInputTokens).toBe(2000);
    expect(recorded.usage.reasoningTokens).toBe(300);
    expect(recorded.usage.inputTokens).toBe(1000);
    expect(recorded.usage.outputTokens).toBe(500);
    // cost includes the cache-read bucket at the reduced 0.5/MTok opus rate:
    //   input 1000·5 + cached 2000·0.5 + output 500·25 (per MTok)
    //   = 0.005 + 0.001 + 0.0125 = 0.0185  (vs 0.0175 with no cache bucket)
    expect(result.costUsd).toBeCloseTo(0.0185, 9);
  });

  it("records a non-zero FALLBACK estimate when the provider omits usage", async () => {
    generateText.mockResolvedValue({
      output: { category: "support", urgency: 1 },
      text: "", // empty under structured output — fallback must use the object
      totalUsage: undefined,
      usage: undefined,
    });

    await runAgent(CFG, { msg: "help me" }, META);

    expect(recordUsage).toHaveBeenCalledOnce();
    const recorded = recordUsage.mock.calls[0][0];
    expect(recorded.usage.inputTokens).toBeGreaterThan(0);
    expect(recorded.usage.outputTokens).toBeGreaterThan(0);
  });

  it("maps provider 401 to a NON-retryable failure and records NO charge", async () => {
    generateText.mockRejectedValue(
      new APICallError({
        message: "unauthorized",
        url: "https://api.anthropic.com/v1/messages",
        requestBodyValues: {},
        statusCode: 401,
      }),
    );

    await expect(runAgent(CFG, { msg: "x" }, META)).rejects.toMatchObject({
      nonRetryable: true,
    });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("pre-flight: rejects (non-retryable BUDGET) over the monthly cap, no charge", async () => {
    getBudget = () =>
      Promise.resolve({
        tenantId: "t1",
        monthlyCapUsd: 0.001, // estimate (~0.0256 on opus) blows past this
        perExecutionCapUsd: 1,
        maxStepsPerRun: 50,
        onBudgetExceeded: "reject",
        fallbackModel: null,
      });
    reserveBudget.mockResolvedValue({ ok: false }); // cap would be exceeded

    await expect(runAgent(CFG, { msg: "x" }, META)).rejects.toMatchObject({
      nonRetryable: true,
      type: "BUDGET",
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("pre-flight: downgrades to the fallback model and records the fallback", async () => {
    // cap sits between the haiku estimate (~0.005) and the opus estimate (~0.026):
    // opus over → downgrade; haiku fits → the call proceeds on haiku.
    getBudget = () =>
      Promise.resolve({
        tenantId: "t1",
        monthlyCapUsd: 0.01,
        perExecutionCapUsd: 1,
        maxStepsPerRun: 50,
        onBudgetExceeded: "downgrade",
        fallbackModel: "claude-haiku-4-5",
      });
    // primary reservation fails, fallback reservation succeeds
    reserveBudget
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, id: "res_fb" });
    generateText.mockResolvedValue({
      output: { category: "support", urgency: 2 },
      text: '{"category":"support","urgency":2}',
      totalUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });

    const result = await runAgent(CFG, { msg: "x" }, META);

    expect(result.model).toBe("claude-haiku-4-5");
    expect(generateText).toHaveBeenCalledOnce();
    expect(recordUsage.mock.calls[0][0].model).toBe("claude-haiku-4-5");
    // the fallback reservation is released after recording the actual usage
    expect(releaseReservation).toHaveBeenCalledWith("res_fb");
  });

  it("pre-flight: rejects when even the fallback exceeds the cap (QA#6, no charge)", async () => {
    getBudget = () =>
      Promise.resolve({
        tenantId: "t1",
        monthlyCapUsd: 0.001, // below even the haiku estimate
        perExecutionCapUsd: 1,
        maxStepsPerRun: 50,
        onBudgetExceeded: "downgrade",
        fallbackModel: "claude-haiku-4-5",
      });
    reserveBudget.mockResolvedValue({ ok: false }); // both primary + fallback over
    await expect(runAgent(CFG, { msg: "x" }, META)).rejects.toMatchObject({
      nonRetryable: true,
      type: "BUDGET",
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("pre-flight: rejects FALLBACK_UNPRICED when the fallback model has no pricing (QA#6)", async () => {
    getBudget = () =>
      Promise.resolve({
        tenantId: "t1",
        monthlyCapUsd: 0.001,
        perExecutionCapUsd: 1,
        maxStepsPerRun: 50,
        onBudgetExceeded: "downgrade",
        fallbackModel: "made-up-model",
      });
    reserveBudget.mockResolvedValue({ ok: false }); // primary over → tries fallback
    await expect(runAgent(CFG, { msg: "x" }, META)).rejects.toMatchObject({
      nonRetryable: true,
      type: "FALLBACK_UNPRICED",
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("maps a missing credential to a NON-retryable AUTH failure", async () => {
    getKey = () =>
      Promise.reject(new MissingCredentialError("t1", "anthropic"));

    await expect(runAgent(CFG, { msg: "x" }, META)).rejects.toMatchObject({
      nonRetryable: true,
      type: "AUTH",
    });
    expect(recordUsage).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });
});
