import { HttpException, HttpStatus } from "@nestjs/common";
import { type TenantBudgetConfig, isOverMonthlyBudget } from "@naary/usage";

/** 402 Payment Required — the tenant's monthly spend cap is already reached. */
export class BudgetExceededException extends HttpException {
  constructor() {
    super(
      "Monthly budget exceeded for this workspace — raise the cap in Budget settings or wait for the next billing month.",
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

/**
 * Fast-fail gate at run START: reject a new run when the tenant is already at/over its monthly
 * cap, so an over-budget workspace gets an immediate 402 instead of starting a run that dies at
 * the first agent node. This is an OPTIMIZATION — the authoritative guard is `reserveBudget`
 * inside the agent activity (which also covers Temporal-native scheduled fires this can't reach).
 *
 * Semantics:
 *  - No cap configured  ⇒ never gated (isOverMonthlyBudget returns false).
 *  - onBudgetExceeded="downgrade" ⇒ do NOT reject — let the run start; the per-call path
 *    downgrades to the fallback model. Only "reject" (the default) hard-stops at start.
 *  - onBudgetExceeded="pause" (Slice 3) ⇒ do NOT reject — the promised semantic is that
 *    runs PARK and resume when the cap is raised or the month rolls over, so a new run
 *    starts and parks at its first reservation instead of 402-ing at the door.
 *  - Metering read fails ⇒ FAIL OPEN. Blocking every run because a `_sum` query hiccuped is
 *    worse than letting the run start and be caught by the reservation. Swallow + proceed.
 */
export async function assertWithinMonthlyBudget(
  tenantId: string,
  budget: TenantBudgetConfig | null,
): Promise<void> {
  if (
    !budget ||
    budget.onBudgetExceeded === "downgrade" ||
    budget.onBudgetExceeded === "pause"
  )
    return;
  let over = false;
  try {
    over = await isOverMonthlyBudget(tenantId, budget.monthlyCapUsd);
  } catch (_err) {
    return; // fail open — the reservation is the real guard
  }
  if (over) throw new BudgetExceededException();
}
