import { getPrisma, Prisma } from "@naary/db";

/** "pause" (redesign Slice 3): a refused reservation PARKS the run (awaiting_budget)
 *  instead of failing it; a budgetResume Signal (cap raise / month rollover) retries. */
export type BudgetPolicy = "reject" | "downgrade" | "pause";

export interface TenantBudgetConfig {
  tenantId: string;
  monthlyCapUsd: number;
  perExecutionCapUsd: number;
  maxStepsPerRun: number;
  onBudgetExceeded: BudgetPolicy;
  fallbackModel: string | null;
  /** Alert threshold as % of monthlyCapUsd (1–100); null = no alert configured. */
  alertThresholdPct: number | null;
}

export interface SetBudgetInput {
  monthlyCapUsd: number;
  perExecutionCapUsd: number;
  maxStepsPerRun?: number;
  onBudgetExceeded?: BudgetPolicy;
  fallbackModel?: string | null;
  alertThresholdPct?: number | null;
}

// Decimal(12,2) money — Number() for in-memory comparisons; toFixed(2) → Decimal on write.
function toConfig(row: {
  tenantId: string;
  monthlyCapUsd: Prisma.Decimal;
  perExecutionCapUsd: Prisma.Decimal;
  maxStepsPerRun: number;
  onBudgetExceeded: string;
  fallbackModel: string | null;
  alertThresholdPct: number | null;
}): TenantBudgetConfig {
  return {
    tenantId: row.tenantId,
    monthlyCapUsd: Number(row.monthlyCapUsd),
    perExecutionCapUsd: Number(row.perExecutionCapUsd),
    maxStepsPerRun: row.maxStepsPerRun,
    onBudgetExceeded: row.onBudgetExceeded as BudgetPolicy,
    fallbackModel: row.fallbackModel,
    alertThresholdPct: row.alertThresholdPct,
  };
}

export async function getBudget(
  tenantId: string,
): Promise<TenantBudgetConfig | null> {
  const row = await getPrisma().tenantBudget.findUnique({
    where: { tenantId },
  });
  return row ? toConfig(row) : null;
}

export async function setBudget(
  tenantId: string,
  input: SetBudgetInput,
): Promise<TenantBudgetConfig> {
  const data = {
    monthlyCapUsd: new Prisma.Decimal(input.monthlyCapUsd.toFixed(2)),
    perExecutionCapUsd: new Prisma.Decimal(input.perExecutionCapUsd.toFixed(2)),
    ...(input.maxStepsPerRun !== undefined
      ? { maxStepsPerRun: input.maxStepsPerRun }
      : {}),
    ...(input.onBudgetExceeded
      ? { onBudgetExceeded: input.onBudgetExceeded }
      : {}),
    fallbackModel: input.fallbackModel ?? null,
    // Like fallbackModel: omitted/null clears the threshold (the editor always sends the
    // full policy). NOTE: lastAlertMonth is deliberately NOT touched here — editing the
    // budget must not re-arm (or forfeit) the current month's exactly-once alert claim.
    alertThresholdPct: input.alertThresholdPct ?? null,
  };
  const row = await getPrisma().tenantBudget.upsert({
    where: { tenantId },
    create: { tenantId, ...data },
    update: data,
  });
  return toConfig(row);
}
