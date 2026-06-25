import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted so the fns exist when the hoisted vi.mock factory runs.
const m = vi.hoisted(() => ({
  getBudget: vi.fn(),
  monthToDateSpend: vi.fn(),
  setBudget: vi.fn(),
}));
vi.mock("@naary/usage", () => m);

import { NotFoundException } from "@nestjs/common";
import { BudgetService } from "../src/budget/budget.service";

beforeEach(() => {
  m.getBudget.mockReset();
  m.monthToDateSpend.mockReset();
});

describe("BudgetService.view", () => {
  it("returns the budget enriched with MTD spend and remaining", async () => {
    m.getBudget.mockResolvedValue({
      tenantId: "t1",
      monthlyCapUsd: 10,
      perExecutionCapUsd: 0.5,
      maxStepsPerRun: 50,
      onBudgetExceeded: "reject",
      fallbackModel: null,
    });
    m.monthToDateSpend.mockResolvedValue(3.25);

    const view = await new BudgetService().view("t1");

    expect(view.monthlyCapUsd).toBe(10);
    expect(view.mtdSpendUsd).toBe(3.25);
    expect(view.remainingUsd).toBeCloseTo(6.75, 6);
  });

  it("throws 404 when no budget is set", async () => {
    m.getBudget.mockResolvedValue(null);
    await expect(new BudgetService().view("ghost")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
