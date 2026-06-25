import { describe, expect, it } from "vitest";
import { UnknownModelPricingError, computeCost } from "../src/pricing";

describe("computeCost", () => {
  it("computes input + output cost for a known model", () => {
    // opus 4.8: $5/MTok in, $25/MTok out → 1000*5e-6 + 500*25e-6 = 0.0175
    const cost = computeCost({
      provider: "anthropic",
      model: "claude-opus-4-8",
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(cost).toBeCloseTo(0.0175, 9);
  });

  it("bills cache-read tokens at the reduced rate", () => {
    // opus 4.8 cache-read: $0.5/MTok → 10000 cached = 0.005 (vs 0.05 at full rate)
    const cost = computeCost({
      provider: "anthropic",
      model: "claude-opus-4-8",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 10_000,
    });
    expect(cost).toBeCloseTo(0.005, 9);
  });

  it("prices a cheaper model lower for identical tokens", () => {
    const opus = computeCost({
      provider: "anthropic",
      model: "claude-opus-4-8",
      inputTokens: 1000,
      outputTokens: 1000,
    });
    const haiku = computeCost({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 1000,
      outputTokens: 1000,
    });
    expect(haiku).toBeLessThan(opus);
  });

  it("throws on an unknown model rather than silently pricing it at zero", () => {
    expect(() =>
      computeCost({
        provider: "anthropic",
        model: "no-such-model",
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).toThrow(UnknownModelPricingError);
  });
});
