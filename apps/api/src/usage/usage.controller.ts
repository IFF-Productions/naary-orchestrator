import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import type { InsightsResult } from "@naary/usage";
import { CurrentPrincipal, type Principal } from "../auth/tenant.decorator";
import { ApiEndpoint } from "../swagger/api-decorators";
import { InsightsResponse, UsageSummaryResponse } from "./usage.response";
import { UsageService, type UsageSummary } from "./usage.service";

@ApiBearerAuth("bearer")
@Controller("tenants/:id/usage")
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @ApiEndpoint({
    summary: "Get usage & spend",
    description:
      "Aggregated + line-item spend from the usage ledger. Optional from/to (ISO date) window. " +
      "Restricted members see only events of workflows they can view.",
    ok: UsageSummaryResponse,
  })
  @Get()
  get(
    @Param("id") id: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<UsageSummary> {
    return this.usage.getUsage(id, from, to, principal);
  }

  @ApiEndpoint({
    summary: "Get usage insights",
    description:
      "Spend & tokens rolled up by day (time-series), environment, workflow, and model. Optional from/to (ISO date) window and environmentId filter. " +
      "Restricted members see only events of workflows they can view.",
    ok: InsightsResponse,
  })
  @Get("insights")
  insights(
    @Param("id") id: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("environmentId") environmentId?: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<InsightsResult> {
    return this.usage.getInsights(id, { from, to, environmentId }, principal);
  }
}
