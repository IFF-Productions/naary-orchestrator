import { Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";

export interface UsageLineItem {
  id: string;
  executionId: string;
  nodeId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  createdAt: Date;
}

export interface UsageSummary {
  totalCostUsd: number;
  totalTokens: number;
  byModel: Array<{
    provider: string;
    model: string;
    calls: number;
    totalTokens: number;
    costUsd: number;
  }>;
  events: UsageLineItem[];
}

const round6 = (n: number) => Number(n.toFixed(6));

@Injectable()
export class UsageService {
  /** Aggregated + line-item spend for a tenant, from the usage ledger. */
  async getUsage(
    tenantId: string,
    from?: string,
    to?: string,
  ): Promise<UsageSummary> {
    const createdAt =
      from || to
        ? {
            ...(from ? { gte: new Date(from) } : {}),
            ...(to ? { lte: new Date(to) } : {}),
          }
        : undefined;

    const rows = await getPrisma().usageEvent.findMany({
      where: { tenantId, ...(createdAt ? { createdAt } : {}) },
      orderBy: { createdAt: "desc" },
    });

    let totalCostUsd = 0;
    let totalTokens = 0;
    const byModel = new Map<
      string,
      {
        provider: string;
        model: string;
        calls: number;
        totalTokens: number;
        costUsd: number;
      }
    >();

    for (const r of rows) {
      const cost = Number(r.costUsd);
      totalCostUsd += cost;
      totalTokens += r.totalTokens;
      const key = `${r.provider}/${r.model}`;
      const agg = byModel.get(key) ?? {
        provider: r.provider,
        model: r.model,
        calls: 0,
        totalTokens: 0,
        costUsd: 0,
      };
      agg.calls += 1;
      agg.totalTokens += r.totalTokens;
      agg.costUsd += cost;
      byModel.set(key, agg);
    }

    return {
      totalCostUsd: round6(totalCostUsd),
      totalTokens,
      byModel: [...byModel.values()].map((m) => ({
        ...m,
        costUsd: round6(m.costUsd),
      })),
      events: rows.map((r) => ({
        id: r.id,
        executionId: r.executionId,
        nodeId: r.nodeId,
        provider: r.provider,
        model: r.model,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        totalTokens: r.totalTokens,
        costUsd: Number(r.costUsd),
        createdAt: r.createdAt,
      })),
    };
  }
}
