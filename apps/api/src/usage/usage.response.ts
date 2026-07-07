import { ApiProperty } from "@nestjs/swagger";

/** Per-provider/model rollup of spend. */
export class UsageByModelResponse {
  @ApiProperty({ example: "anthropic" }) provider!: string;
  @ApiProperty({ example: "claude-sonnet-4" }) model!: string;
  @ApiProperty({ example: 12, description: "Number of billed calls." })
  calls!: number;
  @ApiProperty({ example: 45120 }) totalTokens!: number;
  @ApiProperty({ example: 0.18432 }) costUsd!: number;
}

/** One billed LLM call from the usage ledger. */
export class UsageLineItemResponse {
  @ApiProperty() id!: string;
  @ApiProperty() executionId!: string;
  @ApiProperty() nodeId!: string;
  @ApiProperty({ example: "anthropic" }) provider!: string;
  @ApiProperty({ example: "claude-sonnet-4" }) model!: string;
  @ApiProperty({ example: 1200 }) inputTokens!: number;
  @ApiProperty({ example: 340 }) outputTokens!: number;
  @ApiProperty({ example: 1540 }) totalTokens!: number;
  @ApiProperty({ example: 0.00616 }) costUsd!: number;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
}

/** Aggregated + line-item spend for a tenant. */
export class UsageSummaryResponse {
  @ApiProperty({ example: 1.234567 }) totalCostUsd!: number;
  @ApiProperty({ example: 84210 }) totalTokens!: number;
  @ApiProperty({ type: [UsageByModelResponse] })
  byModel!: UsageByModelResponse[];
  @ApiProperty({ type: [UsageLineItemResponse] })
  events!: UsageLineItemResponse[];
}
