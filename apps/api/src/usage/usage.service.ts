import { Injectable, Optional } from "@nestjs/common";
import { getPrisma } from "@naary/db";
import { type InsightsResult, aggregateInsights } from "@naary/usage";
import type { Principal } from "../auth/tenant.decorator";
import {
  type EnvViewTerm,
  PermissionsService,
  viewTermsAllow,
} from "../permissions/permissions.service";

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

/** The ledger fields the RBAC filter reads (a subset of Prisma's UsageEvent). */
interface FilterableEvent {
  executionId: string;
  environmentId: string | null;
}

@Injectable()
export class UsageService {
  constructor(
    /** @Optional so bare test constructions keep working; when an ACTOR reaches getUsage/
     *  getInsights the service must be wired (fail CLOSED, never skip the view filter). */
    @Optional() private readonly permissions?: PermissionsService,
  ) {}

  /** Aggregated + line-item spend for a tenant, from the usage ledger. RESTRICTED actors
   *  (RBAC G3 — gated insights) see only events of workflows they can VIEW; unrestricted /
   *  absent actors keep the query and result byte-identical. */
  async getUsage(
    tenantId: string,
    from?: string,
    to?: string,
    actor?: Principal,
  ): Promise<UsageSummary> {
    const terms = await this.viewTermsFor(actor, tenantId);
    const createdAt =
      from || to
        ? {
            ...(from ? { gte: new Date(from) } : {}),
            ...(to ? { lte: new Date(to) } : {}),
          }
        : undefined;

    let rows = await getPrisma().usageEvent.findMany({
      where: { tenantId, ...(createdAt ? { createdAt } : {}) },
      orderBy: { createdAt: "desc" },
    });
    if (terms !== null) {
      // Same execution→workflowKey join getInsights builds, here only for restricted
      // subjects — the unrestricted path never pays it.
      const keyByExec = await this.workflowKeyByExec(rows);
      rows = rows.filter((r) => this.eventVisible(terms, r, keyByExec));
    }

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

  /**
   * Usage rolled up along the dimensions a cost dashboard needs: by UTC day (time-series), by
   * environment, by workflow, and by model. Same tenant-scoped ledger as getUsage; the per-workflow
   * breakdown joins each event's executionId to its Execution.workflowKey. `environmentId` filters to
   * a single env (Slice-6a tag). Fetch-then-aggregate mirrors getUsage; the pure rollup lives in
   * @naary/usage `aggregateInsights`. RESTRICTED actors see only events of viewable workflows —
   * filtered BEFORE the rollup, so every bucket (totals/byDay/byEnvironment/byWorkflow/byModel)
   * reflects exactly their slice; unrestricted / absent actors are byte-identical to before.
   */
  async getInsights(
    tenantId: string,
    opts: { from?: string; to?: string; environmentId?: string } = {},
    actor?: Principal,
  ): Promise<InsightsResult> {
    const terms = await this.viewTermsFor(actor, tenantId);
    const { from, to, environmentId } = opts;
    const createdAt =
      from || to
        ? {
            ...(from ? { gte: new Date(from) } : {}),
            ...(to ? { lte: new Date(to) } : {}),
          }
        : undefined;

    let rows = await getPrisma().usageEvent.findMany({
      where: {
        tenantId,
        ...(createdAt ? { createdAt } : {}),
        ...(environmentId ? { environmentId } : {}),
      },
      orderBy: { createdAt: "asc" },
    });

    // Map each run (executionId = Temporal workflowId) to its workflowKey for the per-workflow rollup.
    const workflowKeyByExec = await this.workflowKeyByExec(rows);
    if (terms !== null) {
      rows = rows.filter((r) => this.eventVisible(terms, r, workflowKeyByExec));
    }

    return aggregateInsights(
      rows.map((r) => ({
        executionId: r.executionId,
        environmentId: r.environmentId,
        provider: r.provider,
        model: r.model,
        totalTokens: r.totalTokens,
        costUsd: Number(r.costUsd),
        createdAt: r.createdAt,
      })),
      workflowKeyByExec,
      { from: from ?? null, to: to ?? null },
    );
  }

  /** executionId → workflowKey over the DISTINCT execIds of `rows` (one batched lookup). */
  private async workflowKeyByExec(
    rows: Array<{ executionId: string }>,
  ): Promise<Map<string, string | null>> {
    const execIds = [...new Set(rows.map((r) => r.executionId))];
    const execs = execIds.length
      ? await getPrisma().execution.findMany({
          where: { workflowId: { in: execIds } },
          select: { workflowId: true, workflowKey: true },
        })
      : [];
    return new Map<string, string | null>(
      execs.map((e) => [e.workflowId, e.workflowKey]),
    );
  }

  /** The actor's per-env view terms, or null when unfiltered (no actor / unrestricted). */
  private async viewTermsFor(
    actor: Principal | undefined,
    tenantId: string,
  ): Promise<EnvViewTerm[] | null> {
    if (!actor) return null;
    if (!this.permissions) {
      // Fail CLOSED: an actor implies a user-facing call site — the filter must run.
      throw new Error("UsageService: PermissionsService is not wired");
    }
    return this.permissions.viewTerms(actor, tenantId);
  }

  /** RBAC visibility of one ledger row for a restricted subject: env term rules per
   *  {@link viewTermsAllow} — a NULL environmentId row belongs to the DEFAULT env (same
   *  rule as the runs-list filter), and an event whose executionId resolves to NO
   *  workflowKey is visible only to UNRESTRICTED subjects. */
  private eventVisible(
    terms: EnvViewTerm[],
    row: FilterableEvent,
    keyByExec: Map<string, string | null>,
  ): boolean {
    return viewTermsAllow(
      terms,
      row.environmentId,
      keyByExec.get(row.executionId) ?? null,
    );
  }
}
