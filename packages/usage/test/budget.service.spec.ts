import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, any>();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    tenantBudget: {
      findUnique: async ({ where }: any) => store.get(where.tenantId) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const row = {
          ...(store.get(where.tenantId) ?? create),
          ...update,
          tenantId: where.tenantId,
        };
        store.set(where.tenantId, row);
        return row;
      },
    },
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

import { getBudget, setBudget } from "../src/budget.service";

beforeEach(() => store.clear());

describe("budget.service", () => {
  it("set then get round-trips with numeric money + defaults", async () => {
    const saved = await setBudget("t1", {
      monthlyCapUsd: 10,
      perExecutionCapUsd: 0.5,
    });
    expect(saved.monthlyCapUsd).toBe(10);
    expect(saved.perExecutionCapUsd).toBe(0.5);

    const got = await getBudget("t1");
    expect(got).toMatchObject({
      tenantId: "t1",
      monthlyCapUsd: 10,
      perExecutionCapUsd: 0.5,
      fallbackModel: null,
    });
  });

  it("persists policy + fallback model on downgrade config", async () => {
    const saved = await setBudget("t2", {
      monthlyCapUsd: 100,
      perExecutionCapUsd: 1,
      maxStepsPerRun: 10,
      onBudgetExceeded: "downgrade",
      fallbackModel: "claude-haiku-4-5",
    });
    expect(saved.onBudgetExceeded).toBe("downgrade");
    expect(saved.fallbackModel).toBe("claude-haiku-4-5");
    expect(saved.maxStepsPerRun).toBe(10);
  });

  it("returns null for an unknown tenant", async () => {
    expect(await getBudget("ghost")).toBeNull();
  });
});
