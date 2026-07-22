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

const ANTHROPIC_MODELS: Record<string, ModelPrice> = {
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
};

export const MODEL_PRICING: Record<string, Record<string, ModelPrice>> = {
  anthropic: ANTHROPIC_MODELS,
  // The Claude Code CLI (codeAgent's `claude-code` BYOK credential — its own provider
  // slot since #296, distinct from the `anthropic` model-provider key) runs the SAME
  // Claude models at the same list prices. Shared by reference on purpose: a price
  // update applies to both. Without this key, every codeAgent run died in recordUsage
  // with UnknownModelPricingError after the CLI call had already succeeded.
  "claude-code": ANTHROPIC_MODELS,
  // The other code-agent CLI slots (cursor/copilot BYOK credentials). Their per-model pricing
  // varies (each CLI can run several vendors' models) and isn't published as a stable table, and
  // the codeAgent activity defaults the priced model to a Claude one — so PROXY to the Anthropic
  // table. This is a deliberate fallback ESTIMATE (Tier-1 rule 6: never record $0 — a zero-cost
  // code-agent run would silently evade USD budget enforcement). Refine with real tables later.
  cursor: ANTHROPIC_MODELS,
  copilot: ANTHROPIC_MODELS,
  // OpenAI list prices, USD per million tokens (cached-input = the discounted
  // prompt-cache read rate). As of 2026-06-25. Source: OpenAI API pricing.
  openai: {
    "gpt-4o": {
      inputPerMTok: 2.5,
      outputPerMTok: 10,
      cachedInputPerMTok: 1.25,
    },
    "gpt-4o-mini": {
      inputPerMTok: 0.15,
      outputPerMTok: 0.6,
      cachedInputPerMTok: 0.075,
    },
    "gpt-4.1": {
      inputPerMTok: 2,
      outputPerMTok: 8,
      cachedInputPerMTok: 0.5,
    },
    "gpt-4.1-mini": {
      inputPerMTok: 0.4,
      outputPerMTok: 1.6,
      cachedInputPerMTok: 0.1,
    },
  },
  // Google Gemini list prices, USD per million tokens (representative base-tier rates;
  // Gemini tiers by context length). As of 2026-06-25. Source: Google AI pricing.
  google: {
    "gemini-2.5-pro": {
      inputPerMTok: 1.25,
      outputPerMTok: 10,
      cachedInputPerMTok: 0.31,
    },
    "gemini-2.5-flash": {
      inputPerMTok: 0.3,
      outputPerMTok: 2.5,
      cachedInputPerMTok: 0.075,
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
