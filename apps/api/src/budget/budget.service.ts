import { Injectable, NotFoundException, Optional } from "@nestjs/common";
import {
  type SetBudgetInput,
  type TenantBudgetConfig,
  getBudget,
  monthToDateSpend,
  setBudget,
} from "@naary/usage";
import { BudgetResumeService } from "./budget-resume.service";

export interface BudgetView extends TenantBudgetConfig {
  mtdSpendUsd: number;
  remainingUsd: number;
}

@Injectable()
export class BudgetService {
  /** @Optional so the many bare test constructions keep working; without it the PUT
   *  path simply skips resume delivery (tests that care inject a fake). */
  constructor(@Optional() private readonly resume?: BudgetResumeService) {}

  /** Budget config + live month-to-date spend and remaining (Task 4). */
  async view(tenantId: string): Promise<BudgetView> {
    const budget = await getBudget(tenantId);
    if (!budget) {
      throw new NotFoundException(`No budget set for tenant '${tenantId}'`);
    }
    const mtdSpendUsd = await monthToDateSpend(tenantId);
    return {
      ...budget,
      mtdSpendUsd,
      remainingUsd: Number((budget.monthlyCapUsd - mtdSpendUsd).toFixed(6)),
    };
  }

  async set(
    tenantId: string,
    input: SetBudgetInput,
  ): Promise<TenantBudgetConfig> {
    const saved = await setBudget(tenantId, input);
    // Slice 3 (pause-not-fail resume delivery): ANY budget write — cap raise, policy
    // change — wakes this tenant's awaiting_budget runs. Each woken run re-checks its
    // budget in-activity and simply re-parks if the write didn't actually clear it, so
    // over-signaling is safe. Fire-and-forget + never-throws: a Temporal hiccup must
    // not fail the budget save (the boot reconcile / next PUT retries).
    void this.resume?.resumeTenant(tenantId);
    return saved;
  }
}
