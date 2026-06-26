import { beforeEach, describe, expect, it, vi } from "vitest";

const usageAggregate = vi.fn();
const reservationAggregate = vi.fn();
const reservationCreate = vi.fn();
const reservationDeleteMany = vi.fn();

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

describe("releaseReservation", () => {
  it("deletes the reservation row", async () => {
    reservationDeleteMany.mockResolvedValue({ count: 1 });
    await releaseReservation("res_1");
    expect(reservationDeleteMany).toHaveBeenCalledWith({
      where: { id: "res_1" },
    });
  });
});
