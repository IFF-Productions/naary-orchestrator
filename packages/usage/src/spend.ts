import { getPrisma } from "@naary/db";
import { computeCost } from "./pricing";

/** Sum of recorded cost for the current calendar month (UTC). I/O — activity/API side. */
export async function monthToDateSpend(tenantId: string): Promise<number> {
  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  // DB-side aggregate (QA#13): this runs on every pre-flight budget check, so we
  // sum in Postgres instead of loading a month of rows into memory.
  const agg = await getPrisma().usageEvent.aggregate({
    where: { tenantId, createdAt: { gte: monthStart } },
    _sum: { costUsd: true },
  });
  return Number(Number(agg._sum.costUsd ?? 0).toFixed(6));
}

/**
 * Is the tenant AT or OVER its monthly cap right now? A fast-fail pre-check for the run-start
 * gate — the authoritative per-call guard is still `reserveBudget` inside the agent activity.
 * Returns false when no cap is configured (cap unset / <= 0 ⇒ never gated). Reuses
 * monthToDateSpend, the same source the budget dashboard view reads, so they can't drift.
 */
export async function isOverMonthlyBudget(
  tenantId: string,
  monthlyCapUsd?: number | null,
): Promise<boolean> {
  if (monthlyCapUsd == null || monthlyCapUsd <= 0) return false;
  return (await monthToDateSpend(tenantId)) >= monthlyCapUsd;
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
