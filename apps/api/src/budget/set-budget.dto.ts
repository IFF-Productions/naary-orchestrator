import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsNumber, IsOptional, IsString } from "class-validator";
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
    enum: ["reject", "downgrade"],
    example: "reject",
    description: "Action when a budget is exceeded.",
  })
  @IsOptional()
  @IsIn(["reject", "downgrade"])
  onBudgetExceeded?: SetBudgetInput["onBudgetExceeded"];

  @ApiPropertyOptional({
    nullable: true,
    example: "claude-3-5-haiku",
    description: "Model to downgrade to when onBudgetExceeded='downgrade'.",
  })
  @IsOptional()
  @IsString()
  fallbackModel?: string | null;
}
