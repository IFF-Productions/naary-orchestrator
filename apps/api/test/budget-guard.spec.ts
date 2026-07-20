import { describe, expect, it, vi } from "vitest";

// Unit-test the GUARD'S decision logic in isolation — mock the spend check it depends on.
// (The spend math of isOverMonthlyBudget is covered in packages/usage spend.spec.ts.)
// vi.hoisted so `isOver` is initialized before the hoisted vi.mock factory references it.
//
// NOTE: deliberately NO beforeEach(mockReset/mockClear). Touching this mock in a beforeEach
// makes vitest re-emit a later mock's synchronous throw as an uncaught error (a vitest mock
// instrumentation quirk), which would false-fail the fail-open case. Each test sets its own
// mock behavior (overriding the previous), and the short-circuit tests assert on a call-count
// DELTA instead of `not.toHaveBeenCalled()`, so no reset is needed.
const { isOver } = vi.hoisted(() => ({ isOver: vi.fn() }));
vi.mock("@naary/usage", () => ({ isOverMonthlyBudget: isOver }));

import {
  assertWithinMonthlyBudget,
  BudgetExceededException,
} from "../src/budget/budget-guard";

const REJECT = {
  tenantId: "t1",
  monthlyCapUsd: 10,
  perExecutionCapUsd: 1,
  maxStepsPerRun: 50,
  onBudgetExceeded: "reject" as const,
  fallbackModel: null,
  alertThresholdPct: null,
};

describe("assertWithinMonthlyBudget (run-start gate)", () => {
  it("rejects (402) when the tenant is over the monthly cap", async () => {
    isOver.mockResolvedValue(true);
    await expect(
      assertWithinMonthlyBudget("t1", REJECT),
    ).rejects.toBeInstanceOf(BudgetExceededException);
  });

  it("allows the run when under the cap", async () => {
    isOver.mockResolvedValue(false);
    await expect(
      assertWithinMonthlyBudget("t1", REJECT),
    ).resolves.toBeUndefined();
  });

  it("never gates (nor reads spend) when no budget is configured", async () => {
    const before = isOver.mock.calls.length;
    await expect(
      assertWithinMonthlyBudget("t1", null),
    ).resolves.toBeUndefined();
    expect(isOver.mock.calls.length).toBe(before); // short-circuits before the spend read
  });

  it("does NOT hard-reject in downgrade mode (per-call path downgrades instead)", async () => {
    const before = isOver.mock.calls.length;
    await expect(
      assertWithinMonthlyBudget("t1", {
        ...REJECT,
        onBudgetExceeded: "downgrade",
      }),
    ).resolves.toBeUndefined();
    expect(isOver.mock.calls.length).toBe(before); // short-circuits before the spend read
  });

  it("does NOT hard-reject in PAUSE mode (Slice 3): the run starts and parks at its first reservation", async () => {
    const before = isOver.mock.calls.length;
    await expect(
      assertWithinMonthlyBudget("t1", {
        ...REJECT,
        onBudgetExceeded: "pause",
      }),
    ).resolves.toBeUndefined();
    expect(isOver.mock.calls.length).toBe(before); // short-circuits before the spend read
  });

  it("FAILS OPEN on a metering error (reservation is the real guard)", async () => {
    isOver.mockImplementation(() => {
      throw new Error("db down");
    });
    // A metering failure must NOT surface as a 402 — the guard swallows it and resolves.
    let rejected = false;
    try {
      await assertWithinMonthlyBudget("t1", REJECT);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(false);
  });
});
