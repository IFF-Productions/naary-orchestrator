import { getPrisma, Prisma } from "@naary/db";

/** Dangling reservations (a run crashed mid-call before releasing) stop counting
 *  toward the cap after this window, so they can't wedge a tenant's budget. */
const RESERVATION_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface ReservationResult {
  ok: boolean;
  id?: string;
}

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
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
    return { ok: true, id: row.id };
  });
}

/** Release a reservation once the actual UsageEvent is recorded (or on failure).
 *  Best-effort; a missed release is reaped by the TTL. */
export async function releaseReservation(id: string): Promise<void> {
  await getPrisma().usageReservation.deleteMany({ where: { id } });
}
