import { getPrisma, Prisma } from "@naary/db";
import { computeCost } from "./pricing";

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export interface RecordUsageInput {
  tenantId: string;
  /** Per-env cost-visibility TAG (Slice 6) — the run's env. Optional: a pre-Slice-6 run has none.
   *  Billing is one-bill-per-tenant, so this is NEVER read by the budget aggregate/gate. */
  environmentId?: string;
  executionId: string;
  nodeId: string;
  /** The node TYPE that spent this ("agent" | "codeAgent" | "vectorQuery" | …) — Slice 2.
   *  The recording activity statically knows which node kind it serves, so by-node-type
   *  rollups need no graph join. Optional: older call sites / rows simply have none. */
  nodeType?: string;
  /** Wall-clock duration of the metered call in ms, measured IN the activity around the
   *  provider call (Slice 2). Optional — never fabricated when unknown. */
  durationMs?: number;
  provider: string;
  model: string;
  usage: UsageTokens;
}

/**
 * Compute cost (Task 3) and insert one UsageEvent. The ledger stores tokens +
 * cost only — never prompt/completion text (privacy + payload size).
 */
export async function recordUsage(input: RecordUsageInput) {
  const inputTokens = input.usage.inputTokens ?? 0;
  const outputTokens = input.usage.outputTokens ?? 0;
  const cachedInputTokens = input.usage.cachedInputTokens ?? 0;
  const reasoningTokens = input.usage.reasoningTokens ?? 0;
  const totalTokens = input.usage.totalTokens ?? inputTokens + outputTokens;

  // FAIL-SAFE (CLAUDE.md Tier-1 §6): a missing pricing row must never fail the run —
  // that would kill the node AFTER the model call succeeded and ledger NOTHING (the
  // worst outcome: a paid call with no usage record). Ledger the tokens with cost 0
  // instead; an unpriced provider/model shows up as tokens-without-cost, which is
  // auditable and fixable by adding the pricing row.
  let costUsd = 0;
  try {
    costUsd = computeCost({
      provider: input.provider,
      model: input.model,
      inputTokens,
      outputTokens,
      cachedInputTokens,
    });
  } catch {
    costUsd = 0;
  }

  const data = {
    tenantId: input.tenantId,
    environmentId: input.environmentId ?? null,
    executionId: input.executionId,
    nodeId: input.nodeId,
    nodeType: input.nodeType ?? null,
    // Math.round: PG column is Int; a sub-ms reading must not fail the insert.
    durationMs:
      input.durationMs !== undefined ? Math.round(input.durationMs) : null,
    provider: input.provider,
    model: input.model,
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    reasoningTokens,
    // Decimal(12,6) — fix to 6 places so we never lose sub-cent precision to float.
    costUsd: new Prisma.Decimal(costUsd.toFixed(6)),
  };

  // Idempotent on (executionId, nodeId): if the activity is retried after the
  // model call already recorded usage, the upsert is a no-op (first write wins)
  // — so a retry can never double-write the ledger or double-bill.
  return getPrisma().usageEvent.upsert({
    where: {
      executionId_nodeId: {
        executionId: input.executionId,
        nodeId: input.nodeId,
      },
    },
    create: data,
    update: {}, // keep the original record unchanged
  });
}
