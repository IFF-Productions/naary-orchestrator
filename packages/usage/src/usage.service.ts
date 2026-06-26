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
  executionId: string;
  nodeId: string;
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

  const costUsd = computeCost({
    provider: input.provider,
    model: input.model,
    inputTokens,
    outputTokens,
    cachedInputTokens,
  });

  const data = {
    tenantId: input.tenantId,
    executionId: input.executionId,
    nodeId: input.nodeId,
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
