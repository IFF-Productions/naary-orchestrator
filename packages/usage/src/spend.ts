import { getPrisma } from "@naary/db";
import { computeCost } from "./pricing";

/** Sum of recorded cost for the current calendar month (UTC). I/O — activity/API side. */
export async function monthToDateSpend(tenantId: string): Promise<number> {
  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const rows = await getPrisma().usageEvent.findMany({
    where: { tenantId, createdAt: { gte: monthStart } },
    select: { costUsd: true },
  });
  const total = rows.reduce((sum, r) => sum + Number(r.costUsd), 0);
  return Number(total.toFixed(6));
}

/** Matches runAgent's maxOutputTokens — the worst-case output we'd pay for. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

export interface EstimateConfig {
  provider: string;
  model: string;
  systemPrompt: string;
  maxOutputTokens?: number;
}

/**
 * Estimate a call's cost BEFORE making it: char/4 input tokens (same heuristic as
 * the slice-2 fallback estimator) + assumed max output, priced via computeCost.
 * Deliberately conservative — the recorded UsageEvent is the actual.
 */
export function estimateCallCost(cfg: EstimateConfig, input: unknown): number {
  const inputChars =
    cfg.systemPrompt.length + JSON.stringify(input ?? "").length;
  const inputTokens = Math.max(1, Math.ceil(inputChars / 4));
  const outputTokens = cfg.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  return computeCost({
    provider: cfg.provider,
    model: cfg.model,
    inputTokens,
    outputTokens,
  });
}
