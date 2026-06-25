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

beforeEach(() => {
  generateText.mockReset();
  recordUsage.mockReset().mockResolvedValue({ id: "evt_1" });
  getKey = () => Promise.resolve(SEED_KEY);
  __agentDeps.getCredentials = () =>
    ({ getDecryptedKey: () => getKey() }) as never;
  __agentDeps.recordUsage = recordUsage as never;
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

    expect(result).toEqual({
      status: "ok",
      output: { category: "billing", urgency: 4 },
    });
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
