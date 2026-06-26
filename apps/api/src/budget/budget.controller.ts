import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import type { TenantBudgetConfig } from "@naary/usage";
import { SetBudgetDto } from "./set-budget.dto";
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
    @Body() body: SetBudgetDto,
  ): Promise<TenantBudgetConfig> {
    return this.budget.set(id, body);
  }
}
