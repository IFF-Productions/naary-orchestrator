import { Controller, Get, Param, Query } from "@nestjs/common";
import { UsageService, type UsageSummary } from "./usage.service";

@Controller("tenants/:id/usage")
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  get(
    @Param("id") id: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ): Promise<UsageSummary> {
    return this.usage.getUsage(id, from, to);
  }
}
