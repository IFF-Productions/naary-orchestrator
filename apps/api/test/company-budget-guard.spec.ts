import { describe, expect, it, vi } from "vitest";

// Unit-test the OUTER company gate's decision logic in isolation — mock the DB lookups and the
// company-wide spend read it depends on. (monthToDateSpendForTenants' math is covered in
// packages/usage spend.spec.ts.) vi.hoisted so the mocks are initialized before the hoisted
// vi.mock factories reference them.
//
// NOTE: deliberately NO beforeEach(mockReset/mockClear) — same discipline as budget-guard.spec.ts.
// Touching these mocks in a beforeEach makes vitest re-emit a later mock's synchronous throw as an
// uncaught error (a vitest mock instrumentation quirk), which would false-fail the fail-open
// cases. Each test sets its own mock behavior (overriding the previous), and the short-circuit
// tests assert on a call-count DELTA instead of `not.toHaveBeenCalled()`, so no reset is needed.
const { settingsFindUnique, settingsFindMany, companyBudgetFindUnique, spend } =
  vi.hoisted(() => ({
    settingsFindUnique: vi.fn(),
    settingsFindMany: vi.fn(),
    companyBudgetFindUnique: vi.fn(),
    spend: vi.fn(),
  }));
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    tenantSettings: {
      findUnique: settingsFindUnique,
      findMany: settingsFindMany,
    },
    companyBudget: { findUnique: companyBudgetFindUnique },
  }),
}));
vi.mock("@naary/usage", () => ({ monthToDateSpendForTenants: spend }));

import {
  assertWithinCompanyMonthlyBudget,
  CompanyBudgetExceededException,
} from "../src/budget/company-budget-guard";

// A Prisma CompanyBudget row — Decimal costs stringify; the guard converts via Number().
const BUDGET = {
  companyId: "co1",
  monthlyCapUsd: "10.00",
  onBudgetExceeded: "reject",
};
const MEMBERS = [{ tenantId: "t1" }, { tenantId: "t2" }];

/** Seed the full happy-path chain; individual tests override single links. */
function seedChain() {
  settingsFindUnique.mockResolvedValue({ companyId: "co1" });
  companyBudgetFindUnique.mockResolvedValue(BUDGET);
  settingsFindMany.mockResolvedValue(MEMBERS);
}

describe("assertWithinCompanyMonthlyBudget (company OUTER run-start gate)", () => {
  it("passes a STANDALONE workspace (no companyId) without reading companyBudget", async () => {
    settingsFindUnique.mockResolvedValue({ companyId: null });
    const before = companyBudgetFindUnique.mock.calls.length;
    await expect(
      assertWithinCompanyMonthlyBudget("t1"),
    ).resolves.toBeUndefined();
    expect(companyBudgetFindUnique.mock.calls.length).toBe(before); // short-circuits at the settings read
  });

  it("passes a tenant with NO TenantSettings row at all without reading companyBudget", async () => {
    settingsFindUnique.mockResolvedValue(null);
    const before = companyBudgetFindUnique.mock.calls.length;
    await expect(
      assertWithinCompanyMonthlyBudget("t1"),
    ).resolves.toBeUndefined();
    expect(companyBudgetFindUnique.mock.calls.length).toBe(before);
  });

  it("passes when the company has NO budget row, without aggregating spend", async () => {
    seedChain();
    companyBudgetFindUnique.mockResolvedValue(null);
    const before = spend.mock.calls.length;
    await expect(
      assertWithinCompanyMonthlyBudget("t1"),
    ).resolves.toBeUndefined();
    expect(spend.mock.calls.length).toBe(before); // short-circuits before the spend read
  });

  it("passes when the cap is 0 (gate disabled), without aggregating spend", async () => {
    seedChain();
    companyBudgetFindUnique.mockResolvedValue({
      ...BUDGET,
      monthlyCapUsd: "0.00",
    });
    const before = spend.mock.calls.length;
    await expect(
      assertWithinCompanyMonthlyBudget("t1"),
    ).resolves.toBeUndefined();
    expect(spend.mock.calls.length).toBe(before);
  });

  it("passes in a non-'reject' mode, without aggregating spend", async () => {
    seedChain();
    companyBudgetFindUnique.mockResolvedValue({
      ...BUDGET,
      onBudgetExceeded: "warn",
    });
    const before = spend.mock.calls.length;
    await expect(
      assertWithinCompanyMonthlyBudget("t1"),
    ).resolves.toBeUndefined();
    expect(spend.mock.calls.length).toBe(before);
  });

  it("rejects (402) when company spend is AT the cap, summing across ALL member workspaces", async () => {
    seedChain();
    spend.mockResolvedValue(10);
    await expect(assertWithinCompanyMonthlyBudget("t1")).rejects.toBeInstanceOf(
      CompanyBudgetExceededException,
    );
    // The spend read was company-wide — the enumerated member tenantIds, not just the caller.
    expect(spend).toHaveBeenLastCalledWith(["t1", "t2"]);
  });

  it("rejects (402) when company spend is OVER the cap", async () => {
    seedChain();
    spend.mockResolvedValue(10.01);
    await expect(assertWithinCompanyMonthlyBudget("t1")).rejects.toBeInstanceOf(
      CompanyBudgetExceededException,
    );
  });

  it("allows the run when the company is under its cap", async () => {
    seedChain();
    spend.mockResolvedValue(9.99);
    await expect(
      assertWithinCompanyMonthlyBudget("t1"),
    ).resolves.toBeUndefined();
  });

  // Tier-1 rule 6 (fail-safe billing): a lookup/metering failure must NOT surface as a 402 —
  // the per-tenant reservation inside the agent activity is the real guard. Each link of the
  // chain fails open independently.
  it("FAILS OPEN when the settings lookup throws", async () => {
    seedChain();
    settingsFindUnique.mockImplementation(() => {
      throw new Error("db down");
    });
    let rejected = false;
    try {
      await assertWithinCompanyMonthlyBudget("t1");
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(false);
  });

  it("FAILS OPEN when the company-budget lookup throws", async () => {
    seedChain();
    companyBudgetFindUnique.mockImplementation(() => {
      throw new Error("db down");
    });
    let rejected = false;
    try {
      await assertWithinCompanyMonthlyBudget("t1");
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(false);
  });

  it("FAILS OPEN when the member-workspace enumeration throws", async () => {
    seedChain();
    settingsFindMany.mockImplementation(() => {
      throw new Error("db down");
    });
    let rejected = false;
    try {
      await assertWithinCompanyMonthlyBudget("t1");
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(false);
  });

  it("FAILS OPEN when the spend aggregate throws", async () => {
    seedChain();
    spend.mockImplementation(() => {
      throw new Error("db down");
    });
    let rejected = false;
    try {
      await assertWithinCompanyMonthlyBudget("t1");
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(false);
  });
});
