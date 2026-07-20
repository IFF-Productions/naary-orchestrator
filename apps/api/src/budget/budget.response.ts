import { ApiProperty } from "@nestjs/swagger";

/** A tenant's budget configuration. */
export class TenantBudgetConfigResponse {
  @ApiProperty({ example: "tenant_123" }) tenantId!: string;
  @ApiProperty({ example: 100, description: "Monthly spend cap, USD." })
  monthlyCapUsd!: number;
  @ApiProperty({ example: 5, description: "Per-execution spend cap, USD." })
  perExecutionCapUsd!: number;
  @ApiProperty({ example: 50, description: "Max agent steps per run." })
  maxStepsPerRun!: number;
  @ApiProperty({
    example: "reject",
    enum: ["reject", "downgrade", "pause"],
    description:
      "Action when the monthly cap is exceeded: reject (stop), downgrade (fallback model), or pause (park runs as awaiting_budget until the cap is raised or the month rolls over).",
  })
  onBudgetExceeded!: string;
  @ApiProperty({
    nullable: true,
    example: "claude-3-5-haiku",
    description: "Model to downgrade to when onBudgetExceeded='downgrade'.",
  })
  fallbackModel!: string | null;
  @ApiProperty({
    nullable: true,
    example: 80,
    description:
      "Alert threshold as % of the monthly cap; crossing it emits a budgetThreshold notification (once per calendar month). Null = no alert configured.",
  })
  alertThresholdPct!: number | null;
}

/** Budget config plus live month-to-date spend and remaining balance. */
export class BudgetViewResponse extends TenantBudgetConfigResponse {
  @ApiProperty({ example: 42.5, description: "Month-to-date spend, USD." })
  mtdSpendUsd!: number;
  @ApiProperty({
    example: 57.5,
    description: "Remaining budget for the month, USD.",
  })
  remainingUsd!: number;
}
