import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { budgetResumeSignal } from "@naary/contracts";
import { getPrisma } from "@naary/db";
import type { Client, Connection } from "@temporalio/client";
import { connectTemporal } from "../temporal/client";

/** Signal fan-out chunk — bounds concurrent Temporal RPCs on a large paused backlog. */
const RESUME_BATCH = 25;

/**
 * Resume delivery for budget pause-not-fail (REDESIGN-FUNCTIONALITY-GAPS.md Slice 3).
 * Runs parked as `awaiting_budget` (policy "pause") wake on the `budgetResume` Signal;
 * this service is the ONLY sender, with two triggers:
 *
 *  1. PUT /tenants/:id/budget (cap raise / policy change) → {@link resumeTenant} —
 *     fire-and-forget from BudgetService.set. The workflow re-checks its budget after
 *     the signal, so a resume that doesn't actually clear the cap simply re-parks.
 *  2. Month rollover → {@link reconcileMonthRollover} at boot (the schedule-reconcile
 *     pattern): signal awaiting_budget rows whose pause month (budgetPausedAt, UTC) <
 *     the current month — their monthly spend reset at the rollover. Mid-month worker/
 *     API downtime is covered by this boot pass plus any subsequent PUT; there is no
 *     in-process cron, deliberately — a paused run is durable and loses nothing by
 *     waking at the next boot/PUT instead of midnight.
 *
 * Enumeration reads the Execution READ-MODEL (status = 'awaiting_budget'; rows carry
 * the Temporal workflowId). Sends are BATCHED and BEST-EFFORT: a closed/gone workflow
 * (raced its own resume) or an RPC failure is logged and skipped — it must never fail
 * the PUT or boot. Signal payload is tenantId-ONLY (no secrets, no budget figures).
 */
@Injectable()
export class BudgetResumeService
  implements OnModuleInit, OnModuleDestroy, OnApplicationBootstrap
{
  private readonly logger = new Logger(BudgetResumeService.name);
  private client?: Client;
  private connection?: Connection;

  async onModuleInit(): Promise<void> {
    const { client, connection } = await connectTemporal();
    this.client = client;
    this.connection = connection;
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.close();
  }

  onApplicationBootstrap(): void {
    // Fire-and-forget — boot must not wait on (or die with) Temporal/PG.
    void this.reconcileMonthRollover();
  }

  /** Signal every awaiting_budget run of ONE tenant (the PUT-resume path). Never throws. */
  async resumeTenant(tenantId: string): Promise<{ signaled: number }> {
    try {
      const rows = await getPrisma().execution.findMany({
        where: { tenantId, status: "awaiting_budget" },
        select: { workflowId: true },
      });
      return { signaled: await this.signalAll(rows, tenantId) };
    } catch (e) {
      this.logger.warn(
        `budget resume for tenant ${tenantId} skipped: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return { signaled: 0 };
    }
  }

  /**
   * Month-rollover reconcile (boot): wake awaiting_budget runs paused BEFORE the current
   * UTC calendar month — the month their budget was exhausted in is over. Rows with a
   * NULL budgetPausedAt (a failed stamp) are included defensively: a spurious wake-up
   * just re-parks. Idempotent — a woken run leaves the awaiting_budget read model, so a
   * second boot finds nothing. Never throws.
   */
  async reconcileMonthRollover(): Promise<{ signaled: number }> {
    try {
      const now = new Date();
      const monthStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      );
      const rows = await getPrisma().execution.findMany({
        where: {
          status: "awaiting_budget",
          OR: [
            { budgetPausedAt: { lt: monthStart } },
            { budgetPausedAt: null },
          ],
        },
        select: { workflowId: true, tenantId: true },
      });
      if (rows.length === 0) return { signaled: 0 };
      let signaled = 0;
      // Group per tenant so each signal carries ITS tenant id (informational payload).
      const byTenant = new Map<string, { workflowId: string }[]>();
      for (const r of rows) {
        const list = byTenant.get(r.tenantId) ?? [];
        list.push({ workflowId: r.workflowId });
        byTenant.set(r.tenantId, list);
      }
      for (const [tenantId, tenantRows] of byTenant) {
        signaled += await this.signalAll(tenantRows, tenantId);
      }
      if (signaled > 0) {
        this.logger.log(
          `Budget month-rollover reconcile: resumed ${signaled} paused run(s)`,
        );
      }
      return { signaled };
    } catch (e) {
      this.logger.warn(
        `Budget month-rollover reconcile skipped (will retry next boot): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return { signaled: 0 };
    }
  }

  /** Batched best-effort signal fan-out. Per-run failures are logged, never thrown. */
  private async signalAll(
    rows: { workflowId: string }[],
    tenantId: string,
  ): Promise<number> {
    const client = this.client;
    if (!client || rows.length === 0) return 0;
    let ok = 0;
    for (let i = 0; i < rows.length; i += RESUME_BATCH) {
      const batch = rows.slice(i, i + RESUME_BATCH);
      const results = await Promise.allSettled(
        batch.map((r) =>
          client.workflow
            .getHandle(r.workflowId)
            .signal(budgetResumeSignal, { tenantId }),
        ),
      );
      results.forEach((res, j) => {
        if (res.status === "fulfilled") {
          ok += 1;
        } else {
          // Closed/gone runs race their own resume — informational, not an error.
          this.logger.warn(
            `budgetResume signal to ${batch[j].workflowId} failed: ${
              res.reason instanceof Error
                ? res.reason.message
                : String(res.reason)
            }`,
          );
        }
      });
    }
    return ok;
  }
}
