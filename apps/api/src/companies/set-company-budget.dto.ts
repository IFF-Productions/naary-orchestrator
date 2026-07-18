import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsNumber, IsOptional, Min } from "class-validator";

/** PUT /companies/:id/budget — set the company-wide monthly cap (COMPANIES.md §8, Slice 5). */
export class SetCompanyBudgetDto {
  @ApiProperty({
    example: 500,
    description:
      "Company-wide monthly spend cap, USD, summed across all member workspaces. 0 disables the gate.",
  })
  @IsNumber()
  @Min(0)
  monthlyCapUsd!: number;

  @ApiPropertyOptional({
    enum: ["reject"],
    example: "reject",
    description:
      "Action when the company cap is exceeded. Only 'reject' (hard-stop new runs) exists today.",
  })
  @IsOptional()
  @IsIn(["reject"])
  onBudgetExceeded?: "reject";
}
