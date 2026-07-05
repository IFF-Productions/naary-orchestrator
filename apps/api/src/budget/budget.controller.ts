import { Body, Controller, Get, Param, Put, UseGuards } from "@nestjs/common";
import type { TenantBudgetConfig } from "@naary/usage";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SetBudgetDto } from "./set-budget.dto";
import { BudgetService, type BudgetView } from "./budget.service";

@Controller("tenants/:id/budget")
@UseGuards(RolesGuard)
export class BudgetController {
  constructor(private readonly budget: BudgetService) {}

  @Get()
  view(@Param("id") id: string): Promise<BudgetView> {
    return this.budget.view(id);
  }

  /** Change the budget/caps. Admin+ (design §5). */
  @Put()
  @Roles("admin")
  set(
    @Param("id") id: string,
    @Body() body: SetBudgetDto,
  ): Promise<TenantBudgetConfig> {
    return this.budget.set(id, body);
  }
}
