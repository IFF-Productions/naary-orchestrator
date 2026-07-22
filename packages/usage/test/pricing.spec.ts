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

  it("does NOT double-count cached tokens — input and cache-read are separate buckets (QA#2)", () => {
    // For Anthropic, the SDK's `inputTokens` EXCLUDES cache-read tokens (those are
    // reported separately as cache_read_input_tokens), so input bills at the full
    // rate and the cached portion ONLY at the cache rate — never both.
    const cost = computeCost({
      provider: "anthropic",
      model: "claude-opus-4-8",
      inputTokens: 1000, // 1000 * $5/MTok   = 0.005
      outputTokens: 0,
      cachedInputTokens: 10_000, // 10000 * $0.5/MTok = 0.005
    });
    expect(cost).toBeCloseTo(0.01, 9); // 0.005 + 0.005, cached counted once
    // a double-count (cached also at full rate) would be ~0.06 — guard against it
    expect(cost).toBeLessThan(0.02);
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

  it("prices OpenAI models (multi-provider)", () => {
    // gpt-4o: $2.5/MTok in, $10/MTok out → 1000*2.5e-6 + 500*10e-6 = 0.0075
    expect(
      computeCost({
        provider: "openai",
        model: "gpt-4o",
        inputTokens: 1000,
        outputTokens: 500,
      }),
    ).toBeCloseTo(0.0075, 9);
    // gpt-4o-mini is far cheaper than gpt-4o for identical tokens
    const mini = computeCost({
      provider: "openai",
      model: "gpt-4o-mini",
      inputTokens: 1000,
      outputTokens: 1000,
    });
    const full = computeCost({
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 1000,
      outputTokens: 1000,
    });
    expect(mini).toBeLessThan(full);
  });

  it("prices Google Gemini models (multi-provider)", () => {
    // gemini-2.5-pro: $1.25/MTok in, $10/MTok out → 1000*1.25e-6 + 500*10e-6 = 0.00625
    expect(
      computeCost({
        provider: "google",
        model: "gemini-2.5-pro",
        inputTokens: 1000,
        outputTokens: 500,
      }),
    ).toBeCloseTo(0.00625, 9);
    // flash is cheaper than pro for identical tokens
    const flash = computeCost({
      provider: "google",
      model: "gemini-2.5-flash",
      inputTokens: 1000,
      outputTokens: 1000,
    });
    const pro = computeCost({
      provider: "google",
      model: "gemini-2.5-pro",
      inputTokens: 1000,
      outputTokens: 1000,
    });
    expect(flash).toBeLessThan(pro);
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

  it("prices the claude-code provider identically to anthropic (codeAgent regression)", () => {
    // Since #296 codeAgent bills under its own `claude-code` credential slot; a missing
    // pricing key here made EVERY codeAgent run die in recordUsage after the CLI succeeded.
    const tokens = { inputTokens: 100_000, outputTokens: 50_000 };
    for (const model of ["claude-opus-4-8", "claude-haiku-4-5"]) {
      expect(computeCost({ provider: "claude-code", model, ...tokens })).toBe(
        computeCost({ provider: "anthropic", model, ...tokens }),
      );
    }
  });

  it("prices the cursor/copilot code-agent slots (proxy) so cost is NEVER $0 (Tier-1 rule 6)", () => {
    // #568 review: without a pricing row, a cursor/copilot run recorded $0 → silently evaded USD
    // budget enforcement. They proxy the Anthropic table (the codeAgent model default is a Claude
    // model), so the default-model cost is real + non-zero.
    const tokens = { inputTokens: 100_000, outputTokens: 50_000 };
    for (const provider of ["cursor", "copilot"]) {
      const cost = computeCost({
        provider,
        model: "claude-opus-4-8",
        ...tokens,
      });
      expect(cost).toBeGreaterThan(0);
      expect(cost).toBe(
        computeCost({
          provider: "anthropic",
          model: "claude-opus-4-8",
          ...tokens,
        }),
      );
    }
  });
});
