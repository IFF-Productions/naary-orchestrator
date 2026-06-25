/**
 * Model pricing in USD per million tokens.
 *
 * Prices are configuration and DO change — update the "as of" date and source
 * when they do.
 *
 * As of 2026-06-25. Source: Anthropic pricing
 * (https://platform.claude.com/docs/en/about-claude/models/overview).
 * Cache-read is ~0.1× the input rate for Anthropic models.
 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Cache-read rate (tokens served from the prompt cache). */
  cachedInputPerMTok: number;
}

export const PRICING_AS_OF = "2026-06-25";

export const MODEL_PRICING: Record<string, Record<string, ModelPrice>> = {
  anthropic: {
    "claude-opus-4-8": {
      inputPerMTok: 5,
      outputPerMTok: 25,
      cachedInputPerMTok: 0.5,
    },
    "claude-opus-4-7": {
      inputPerMTok: 5,
      outputPerMTok: 25,
      cachedInputPerMTok: 0.5,
    },
    "claude-opus-4-6": {
      inputPerMTok: 5,
      outputPerMTok: 25,
      cachedInputPerMTok: 0.5,
    },
    "claude-sonnet-4-6": {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cachedInputPerMTok: 0.3,
    },
    "claude-haiku-4-5": {
      inputPerMTok: 1,
      outputPerMTok: 5,
      cachedInputPerMTok: 0.1,
    },
    "claude-fable-5": {
      inputPerMTok: 10,
      outputPerMTok: 50,
      cachedInputPerMTok: 1,
    },
  },
};

export class UnknownModelPricingError extends Error {
  constructor(provider: string, model: string) {
    super(`No pricing configured for ${provider}/${model}`);
    this.name = "UnknownModelPricingError";
  }
}

export interface CostInput {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Cache-read tokens, billed at the reduced rate. Separate from inputTokens. */
  cachedInputTokens?: number;
}

/**
 * Compute the USD cost of a single model call. `inputTokens` and
 * `cachedInputTokens` are separate billable buckets (matching the usage ledger):
 * full-rate input and cache-read input respectively.
 */
export function computeCost(input: CostInput): number {
  const price = MODEL_PRICING[input.provider]?.[input.model];
  if (!price) {
    throw new UnknownModelPricingError(input.provider, input.model);
  }
  const cached = input.cachedInputTokens ?? 0;
  return (
    (input.inputTokens / 1_000_000) * price.inputPerMTok +
    (cached / 1_000_000) * price.cachedInputPerMTok +
    (input.outputTokens / 1_000_000) * price.outputPerMTok
  );
}
