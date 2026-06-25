import { getPrisma, Prisma } from "@naary/db";

export type BudgetPolicy = "reject" | "downgrade";

export interface TenantBudgetConfig {
  tenantId: string;
  monthlyCapUsd: number;
  perExecutionCapUsd: number;
  maxStepsPerRun: number;
  onBudgetExceeded: BudgetPolicy;
  fallbackModel: string | null;
}

export interface SetBudgetInput {
  monthlyCapUsd: number;
  perExecutionCapUsd: number;
  maxStepsPerRun?: number;
  onBudgetExceeded?: BudgetPolicy;
  fallbackModel?: string | null;
}

// Decimal(12,2) money — Number() for in-memory comparisons; toFixed(2) → Decimal on write.
function toConfig(row: {
  tenantId: string;
  monthlyCapUsd: Prisma.Decimal;
  perExecutionCapUsd: Prisma.Decimal;
  maxStepsPerRun: number;
  onBudgetExceeded: string;
  fallbackModel: string | null;
}): TenantBudgetConfig {
  return {
    tenantId: row.tenantId,
    monthlyCapUsd: Number(row.monthlyCapUsd),
    perExecutionCapUsd: Number(row.perExecutionCapUsd),
    maxStepsPerRun: row.maxStepsPerRun,
    onBudgetExceeded: row.onBudgetExceeded as BudgetPolicy,
    fallbackModel: row.fallbackModel,
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
  };
  const row = await getPrisma().tenantBudget.upsert({
    where: { tenantId },
    create: { tenantId, ...data },
    update: data,
  });
  return toConfig(row);
}
