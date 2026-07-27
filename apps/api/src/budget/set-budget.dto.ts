import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";
import type { SetBudgetInput } from "@naary/usage";

export class SetBudgetDto implements SetBudgetInput {
  @ApiProperty({ example: 100, description: "Monthly spend cap, USD." })
  @IsNumber()
  monthlyCapUsd!: number;

  @ApiProperty({ example: 5, description: "Per-execution spend cap, USD." })
  @IsNumber()
  perExecutionCapUsd!: number;

  @ApiPropertyOptional({ example: 50, description: "Max agent steps per run." })
  @IsOptional()
  @IsNumber()
  maxStepsPerRun?: number;

  @ApiPropertyOptional({
    enum: ["reject", "downgrade", "pause"],
    example: "reject",
    description:
      "Action when the monthly cap is exceeded: reject (stop), downgrade (fallback model), or pause (park runs as awaiting_budget; they resume on cap raise or month rollover).",
  })
  @IsOptional()
  @IsIn(["reject", "downgrade", "pause"])
  onBudgetExceeded?: SetBudgetInput["onBudgetExceeded"];

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    example: 80,
    minimum: 1,
    maximum: 100,
    description:
      "Alert threshold as % of the monthly cap (1–100). Crossing it emits a budgetThreshold notification (at most once per calendar month). Omit/null = no alert.",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  alertThresholdPct?: number | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: "claude-3-5-haiku",
    description: "Model to downgrade to when onBudgetExceeded='downgrade'.",
  })
  @IsOptional()
  @IsString()
  fallbackModel?: string | null;
}
