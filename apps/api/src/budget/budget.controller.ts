import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import type { SetBudgetInput, TenantBudgetConfig } from "@naary/usage";
import { BudgetService, type BudgetView } from "./budget.service";

@Controller("tenants/:id/budget")
export class BudgetController {
  constructor(private readonly budget: BudgetService) {}

  @Get()
  view(@Param("id") id: string): Promise<BudgetView> {
    return this.budget.view(id);
  }

  @Put()
  set(
    @Param("id") id: string,
    @Body() body: SetBudgetInput,
  ): Promise<TenantBudgetConfig> {
    return this.budget.set(id, body);
  }
}
