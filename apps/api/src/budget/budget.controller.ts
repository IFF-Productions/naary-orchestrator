import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import type { TenantBudgetConfig } from "@naary/usage";
import { ApiEndpoint } from "../swagger/api-decorators";
import {
  BudgetViewResponse,
  TenantBudgetConfigResponse,
} from "./budget.response";
import { SetBudgetDto } from "./set-budget.dto";
import { BudgetService, type BudgetView } from "./budget.service";

@ApiBearerAuth("bearer")
@Controller("tenants/:id/budget")
export class BudgetController {
  constructor(private readonly budget: BudgetService) {}

  @ApiEndpoint({
    summary: "Get the tenant's budget",
    description:
      "Budget config plus live month-to-date spend and remaining balance.",
    ok: BudgetViewResponse,
    notFound: true,
  })
  @Get()
  view(@Param("id") id: string): Promise<BudgetView> {
    return this.budget.view(id);
  }

  @ApiEndpoint({
    summary: "Set the tenant's budget",
    ok: TenantBudgetConfigResponse,
  })
  @Put()
  set(
    @Param("id") id: string,
    @Body() body: SetBudgetDto,
  ): Promise<TenantBudgetConfig> {
    return this.budget.set(id, body);
  }
}
