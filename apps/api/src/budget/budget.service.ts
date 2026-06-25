import { Injectable, NotFoundException } from "@nestjs/common";
import {
  type SetBudgetInput,
  type TenantBudgetConfig,
  getBudget,
  monthToDateSpend,
  setBudget,
} from "@naary/usage";

export interface BudgetView extends TenantBudgetConfig {
  mtdSpendUsd: number;
  remainingUsd: number;
}

@Injectable()
export class BudgetService {
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

  set(tenantId: string, input: SetBudgetInput): Promise<TenantBudgetConfig> {
    return setBudget(tenantId, input);
  }
}
