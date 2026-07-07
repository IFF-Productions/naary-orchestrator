import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { ApiEndpoint } from "../swagger/api-decorators";
import { UsageSummaryResponse } from "./usage.response";
import { UsageService, type UsageSummary } from "./usage.service";

@ApiBearerAuth("bearer")
@Controller("tenants/:id/usage")
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @ApiEndpoint({
    summary: "Get usage & spend",
    description:
      "Aggregated + line-item spend from the usage ledger. Optional from/to (ISO date) window.",
    ok: UsageSummaryResponse,
  })
  @Get()
  get(
    @Param("id") id: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ): Promise<UsageSummary> {
    return this.usage.getUsage(id, from, to);
  }
}
