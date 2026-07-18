import { HttpException, HttpStatus } from "@nestjs/common";
import { getPrisma } from "@naary/db";
import { monthToDateSpendForTenants } from "@naary/usage";

/** 402 Payment Required — the company-wide monthly spend cap is already reached. */
export class CompanyBudgetExceededException extends HttpException {
  constructor() {
    super(
      "Monthly budget exceeded for this workspace's company — raise the company cap in the company console or wait for the next billing month.",
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

/**
 * OUTER company gate at run START (COMPANIES.md §8, Slice 5), layered ABOVE the per-workspace
 * `assertWithinMonthlyBudget` — a run must pass BOTH. Rejects a new run when the workspace's
 * company is already at/over its company-wide monthly cap (summed across ALL member workspaces).
 * Like the tenant gate, this is an OPTIMIZATION at start time only — the authoritative guard is
 * the per-tenant `reserveBudget` inside the agent activity (there is no company-level
 * reservation; a bounded in-flight overshoot past the company cap is accepted).
 *
 * Semantics:
 *  - Standalone workspace (no companyId) ⇒ never gated — no company row is even read.
 *  - No CompanyBudget row, cap unset/<= 0, or mode !== "reject" ⇒ never gated.
 *  - Company month-to-date spend (all member workspaces) >= cap ⇒ 402.
 *  - ANY lookup/metering read fails ⇒ FAIL OPEN (Tier-1 rule 6: blocking every run because a
 *    lookup hiccuped is worse than letting the run be caught by the reservation). The entire
 *    chain is wrapped; only the final over-cap throw escapes.
 */
export async function assertWithinCompanyMonthlyBudget(
  tenantId: string,
): Promise<void> {
  let over = false;
  try {
    const settings = await getPrisma().tenantSettings.findUnique({
      where: { tenantId },
      select: { companyId: true },
    });
    const companyId = settings?.companyId;
    if (!companyId) return; // standalone workspace — no outer gate
    const budget = await getPrisma().companyBudget.findUnique({
      where: { companyId },
    });
    if (!budget) return;
    const cap = Number(budget.monthlyCapUsd);
    if (cap <= 0 || budget.onBudgetExceeded !== "reject") return;
    const members = await getPrisma().tenantSettings.findMany({
      where: { companyId },
      select: { tenantId: true },
    });
    over =
      (await monthToDateSpendForTenants(members.map((m) => m.tenantId))) >= cap;
  } catch (_err) {
    return; // fail open — the per-tenant reservation is the real guard
  }
  if (over) throw new CompanyBudgetExceededException();
}
