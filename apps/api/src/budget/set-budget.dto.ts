import { IsIn, IsNumber, IsOptional, IsString } from "class-validator";
import type { SetBudgetInput } from "@naary/usage";

export class SetBudgetDto implements SetBudgetInput {
  @IsNumber()
  monthlyCapUsd!: number;

  @IsNumber()
  perExecutionCapUsd!: number;

  @IsOptional()
  @IsNumber()
  maxStepsPerRun?: number;

  @IsOptional()
  @IsIn(["reject", "downgrade"])
  onBudgetExceeded?: SetBudgetInput["onBudgetExceeded"];

  @IsOptional()
  @IsString()
  fallbackModel?: string | null;
}
