import { getPrisma, Prisma } from "@naary/db";

/** Dangling reservations (a run crashed mid-call before releasing) stop counting
 *  toward the cap after this window, so they can't wedge a tenant's budget. */
const RESERVATION_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface ReservationResult {
  ok: boolean;
  id?: string;
  /** Set when THIS reservation first crossed the tenant's alert threshold this calendar
   *  month (redesign Slice 3) — the caller owns firing the (fail-safe, fire-and-forget)
   *  budgetThreshold notification. At most one reservation per tenant per month carries
   *  this (see the transactional claim below). */
  thresholdCrossed?: {
    pct: number;
    /** Month spend at the crossing: committed + in-flight reservations + this estimate. */
    spendUsd: number;
    capUsd: number;
  };
}

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** UTC calendar-month key, e.g. "2026-07" — the exactly-once alert marker granularity. */
export function monthKeyUtc(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Atomically reserve `estimatedCostUsd` against the tenant's monthly cap
 * (Arch§4.3). In a transaction it sums COMMITTED spend (this month's UsageEvents)
 * + ACTIVE reservations (younger than the TTL); if that plus this estimate would
 * exceed the cap it reserves nothing and returns { ok: false } (caller rejects or
 * downgrades). Otherwise it inserts a reservation row so concurrent runs see it —
 * bounding overshoot to the small read-commit race window instead of unbounded.
 */
export async function reserveBudget(
  tenantId: string,
  estimatedCostUsd: number,
  monthlyCapUsd: number,
  now: Date = new Date(),
  /** Alert threshold as % of monthlyCapUsd (redesign Slice 3); null/undefined = no alert. */
  alertThresholdPct?: number | null,
): Promise<ReservationResult> {
  const monthStart = monthStartUtc(now);
  const ttlCutoff = new Date(now.getTime() - RESERVATION_TTL_MS);

  return getPrisma().$transaction(async (tx) => {
    const committed = await tx.usageEvent.aggregate({
      _sum: { costUsd: true },
      where: { tenantId, createdAt: { gte: monthStart } },
    });
    const reserved = await tx.usageReservation.aggregate({
      _sum: { estimatedCostUsd: true },
      where: { tenantId, createdAt: { gte: ttlCutoff } },
    });
    const total =
      Number(committed._sum.costUsd ?? 0) +
      Number(reserved._sum.estimatedCostUsd ?? 0) +
      estimatedCostUsd;
    if (total > monthlyCapUsd) {
      return { ok: false };
    }
    const row = await tx.usageReservation.create({
      data: {
        tenantId,
        estimatedCostUsd: new Prisma.Decimal(estimatedCostUsd.toFixed(6)),
      },
    });

    // Alert-threshold crossing (Slice 3), AT MOST ONCE per calendar month per tenant.
    // The claim is a single guarded UPDATE on the TenantBudget row INSIDE this same
    // transaction. RACE POSTURE: two concurrent reservations both past the threshold
    // serialize on the TenantBudget row lock — the loser re-evaluates the guard after
    // the winner's committed write and matches 0 rows, so exactly one caller sees
    // thresholdCrossed. If THIS transaction later aborts, the claim rolls back with it
    // (no month is burned by a reservation that never happened). If the claim commits
    // but the caller's notification send then fails, the alert is lost for the month —
    // the documented fail-safe trade: a missed alert over ever blocking a reservation.
    const result: ReservationResult = { ok: true, id: row.id };
    if (
      alertThresholdPct != null &&
      alertThresholdPct > 0 &&
      total >= monthlyCapUsd * (alertThresholdPct / 100)
    ) {
      const month = monthKeyUtc(now);
      const claimed = await tx.tenantBudget.updateMany({
        // Explicit null-arm: Prisma's `not` does not match NULL rows, and a tenant that
        // has never alerted has lastAlertMonth NULL.
        where: {
          tenantId,
          OR: [{ lastAlertMonth: null }, { lastAlertMonth: { not: month } }],
        },
        data: { lastAlertMonth: month },
      });
      if (claimed.count === 1) {
        result.thresholdCrossed = {
          pct: alertThresholdPct,
          spendUsd: Number(total.toFixed(6)),
          capUsd: monthlyCapUsd,
        };
      }
    }
    return result;
  });
}

/** Release a reservation once the actual UsageEvent is recorded (or on failure).
 *  Best-effort; a missed release is reaped by the TTL. */
export async function releaseReservation(id: string): Promise<void> {
  await getPrisma().usageReservation.deleteMany({ where: { id } });
}
