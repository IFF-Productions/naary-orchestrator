import { beforeEach, describe, expect, it, vi } from "vitest";

const usageAggregate = vi.fn();
const reservationAggregate = vi.fn();
const reservationCreate = vi.fn();
const reservationDeleteMany = vi.fn();
const budgetUpdateMany = vi.fn();

vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    // run the transaction callback with a tx that has the mocked tables
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        usageEvent: { aggregate: usageAggregate },
        usageReservation: {
          aggregate: reservationAggregate,
          create: reservationCreate,
        },
        tenantBudget: { updateMany: budgetUpdateMany },
      }),
    usageReservation: { deleteMany: reservationDeleteMany },
  }),
  Prisma: {
    Decimal: class {
      constructor(public v: string) {}
      toString() {
        return this.v;
      }
    },
  },
}));

import { releaseReservation, reserveBudget } from "../src/reservation";

beforeEach(() => {
  usageAggregate.mockReset();
  reservationAggregate.mockReset();
  reservationCreate.mockReset();
  reservationDeleteMany.mockReset();
  budgetUpdateMany.mockReset();
});

describe("reserveBudget", () => {
  it("reserves when committed + in-flight reservations + estimate fit the cap", async () => {
    usageAggregate.mockResolvedValue({ _sum: { costUsd: "1.0" } });
    reservationAggregate.mockResolvedValue({
      _sum: { estimatedCostUsd: "0.5" },
    });
    reservationCreate.mockResolvedValue({ id: "res_1" });

    const r = await reserveBudget("t1", 0.3, 5); // 1.0 + 0.5 + 0.3 = 1.8 ≤ 5
    expect(r).toEqual({ ok: true, id: "res_1" });
    expect(reservationCreate).toHaveBeenCalledOnce();
  });

  it("refuses (ok:false, no insert) when another in-flight reservation pushes it over", async () => {
    usageAggregate.mockResolvedValue({ _sum: { costUsd: "4.0" } });
    reservationAggregate.mockResolvedValue({
      _sum: { estimatedCostUsd: "0.8" },
    }); // concurrent run
    const r = await reserveBudget("t1", 0.5, 5); // 4.0 + 0.8 + 0.5 = 5.3 > 5
    expect(r.ok).toBe(false);
    expect(reservationCreate).not.toHaveBeenCalled();
  });

  it("treats null sums as 0", async () => {
    usageAggregate.mockResolvedValue({ _sum: { costUsd: null } });
    reservationAggregate.mockResolvedValue({
      _sum: { estimatedCostUsd: null },
    });
    reservationCreate.mockResolvedValue({ id: "res_2" });
    expect((await reserveBudget("t1", 0.1, 5)).ok).toBe(true);
  });
});

describe("reserveBudget — alert threshold (Slice 3)", () => {
  const NOW = new Date("2026-07-17T12:00:00Z");

  it("no threshold configured → never touches the budget row, no crossing", async () => {
    usageAggregate.mockResolvedValue({ _sum: { costUsd: "3.0" } });
    reservationAggregate.mockResolvedValue({
      _sum: { estimatedCostUsd: null },
    });
    reservationCreate.mockResolvedValue({ id: "res_a" });
    const r = await reserveBudget("t1", 1.5, 5, NOW);
    expect(r.thresholdCrossed).toBeUndefined();
    expect(budgetUpdateMany).not.toHaveBeenCalled();
  });

  it("below the threshold → no claim attempted", async () => {
    usageAggregate.mockResolvedValue({ _sum: { costUsd: "1.0" } });
    reservationAggregate.mockResolvedValue({
      _sum: { estimatedCostUsd: null },
    });
    reservationCreate.mockResolvedValue({ id: "res_b" });
    const r = await reserveBudget("t1", 0.5, 5, NOW, 80); // 1.5 < 4.0
    expect(r.thresholdCrossed).toBeUndefined();
    expect(budgetUpdateMany).not.toHaveBeenCalled();
  });

  it("first crossing claims the month marker transactionally and reports the figures", async () => {
    usageAggregate.mockResolvedValue({ _sum: { costUsd: "3.5" } });
    reservationAggregate.mockResolvedValue({
      _sum: { estimatedCostUsd: null },
    });
    reservationCreate.mockResolvedValue({ id: "res_c" });
    budgetUpdateMany.mockResolvedValue({ count: 1 }); // guard matched → we own the alert
    const r = await reserveBudget("t1", 0.7, 5, NOW, 80); // 4.2 ≥ 4.0
    expect(r.ok).toBe(true);
    expect(r.thresholdCrossed).toEqual({ pct: 80, spendUsd: 4.2, capUsd: 5 });
    // The claim's guard: month key "YYYY-MM", NULL-armed inequality (Prisma `not`
    // alone would skip never-alerted NULL rows).
    expect(budgetUpdateMany).toHaveBeenCalledWith({
      where: {
        tenantId: "t1",
        OR: [{ lastAlertMonth: null }, { lastAlertMonth: { not: "2026-07" } }],
      },
      data: { lastAlertMonth: "2026-07" },
    });
  });

  it("AT MOST ONCE per month: a later crossing in the same month loses the claim (count 0)", async () => {
    usageAggregate.mockResolvedValue({ _sum: { costUsd: "4.4" } });
    reservationAggregate.mockResolvedValue({
      _sum: { estimatedCostUsd: null },
    });
    reservationCreate.mockResolvedValue({ id: "res_d" });
    budgetUpdateMany.mockResolvedValue({ count: 0 }); // marker already = this month
    const r = await reserveBudget("t1", 0.1, 5, NOW, 80);
    expect(r.ok).toBe(true);
    expect(r.thresholdCrossed).toBeUndefined();
  });

  it("a NEW calendar month re-arms the claim (different month key)", async () => {
    usageAggregate.mockResolvedValue({ _sum: { costUsd: "4.0" } });
    reservationAggregate.mockResolvedValue({
      _sum: { estimatedCostUsd: null },
    });
    reservationCreate.mockResolvedValue({ id: "res_e" });
    budgetUpdateMany.mockResolvedValue({ count: 1 });
    const r = await reserveBudget(
      "t1",
      0.2,
      5,
      new Date("2026-08-02T00:30:00Z"),
      80,
    );
    expect(r.thresholdCrossed).toMatchObject({ pct: 80 });
    expect(budgetUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastAlertMonth: "2026-08" } }),
    );
  });

  it("an OVER-CAP refusal reserves nothing and never claims the alert", async () => {
    usageAggregate.mockResolvedValue({ _sum: { costUsd: "5.0" } });
    reservationAggregate.mockResolvedValue({
      _sum: { estimatedCostUsd: null },
    });
    const r = await reserveBudget("t1", 0.5, 5, NOW, 80);
    expect(r.ok).toBe(false);
    expect(budgetUpdateMany).not.toHaveBeenCalled();
  });
});

describe("releaseReservation", () => {
  it("deletes the reservation row", async () => {
    reservationDeleteMany.mockResolvedValue({ count: 1 });
    await releaseReservation("res_1");
    expect(reservationDeleteMany).toHaveBeenCalledWith({
      where: { id: "res_1" },
    });
  });
});
