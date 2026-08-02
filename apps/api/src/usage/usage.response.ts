import { ApiProperty } from "@nestjs/swagger";

/** Per-provider/model rollup of spend. */
export class UsageByModelResponse {
  @ApiProperty({ example: "anthropic" }) provider!: string;
  @ApiProperty({ example: "claude-sonnet-4" }) model!: string;
  @ApiProperty({ example: 12, description: "Number of billed calls." })
  calls!: number;
  @ApiProperty({ example: 45120 }) totalTokens!: number;
  @ApiProperty({ example: 0.18432 }) costUsd!: number;
  @ApiProperty({
    example: 1,
    description:
      "How many of `calls` booked ESTIMATED token counts — the fail-safe used when a provider reports no usage, so a real call is never billed as free. 0 means every call here was metered.",
  })
  estimatedCalls!: number;
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
  @ApiProperty({
    example: false,
    description:
      "Whether this row's TOKEN counts are an estimate rather than a provider measurement. Scoped to tokens: a metered row can still carry a fallback PRICE (an unpriced model bills at 0).",
  })
  estimated!: boolean;
}

/** Aggregated + line-item spend for a tenant. */
export class UsageSummaryResponse {
  @ApiProperty({ example: 1.234567 }) totalCostUsd!: number;
  @ApiProperty({ example: 84210 }) totalTokens!: number;
  @ApiProperty({
    example: 2,
    description:
      "How many calls in this window booked ESTIMATED token counts. 0 means the totals above are entirely metered.",
  })
  estimatedCalls!: number;
  @ApiProperty({ type: [UsageByModelResponse] })
  byModel!: UsageByModelResponse[];
  @ApiProperty({ type: [UsageLineItemResponse] })
  events!: UsageLineItemResponse[];
}

// --- Insights (usage rolled up by day / environment / workflow / model) ---

/** The cost/tokens/calls totals shared by every insights bucket. */
export class InsightsBucketResponse {
  @ApiProperty({ example: 0.18432 }) costUsd!: number;
  @ApiProperty({ example: 45120 }) totalTokens!: number;
  @ApiProperty({ example: 12, description: "Number of billed calls." })
  calls!: number;
  @ApiProperty({
    example: 1,
    description:
      "How many of `calls` booked ESTIMATED token counts rather than provider-measured ones. Lets a dashboard qualify the cost beside it instead of presenting a partly-estimated figure as metered.",
  })
  estimatedCalls!: number;
}

export class InsightsByDayResponse extends InsightsBucketResponse {
  @ApiProperty({ example: "2026-07-16", description: "UTC calendar day." })
  date!: string;
}

export class InsightsByEnvironmentResponse extends InsightsBucketResponse {
  @ApiProperty({
    type: String,
    nullable: true,
    example: "env-prod",
    description: "Environment id; null for spend recorded before env tagging.",
  })
  environmentId!: string | null;
}

export class InsightsByWorkflowResponse extends InsightsBucketResponse {
  @ApiProperty({
    type: String,
    nullable: true,
    example: "support-triage",
    description: "Workflow key; null for runs with no key (pre-migration).",
  })
  workflowKey!: string | null;
}

export class InsightsByModelResponse extends InsightsBucketResponse {
  @ApiProperty({ example: "anthropic" }) provider!: string;
  @ApiProperty({ example: "claude-sonnet-4" }) model!: string;
}

export class InsightsByNodeTypeResponse extends InsightsBucketResponse {
  @ApiProperty({
    type: String,
    nullable: true,
    example: "agent",
    description:
      "Node type that spent this (stamped on the ledger row); null for pre-feature rows.",
  })
  nodeType!: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 1840,
    description:
      "Average measured call duration in ms over rows that carry one; null when none do.",
  })
  avgDurationMs!: number | null;
}

/** One UTC day of run outcomes — from the Execution read-model, not the ledger. */
export class InsightsRunsByDayResponse {
  @ApiProperty({ example: "2026-07-16", description: "UTC calendar day." })
  date!: string;
  @ApiProperty({
    example: 42,
    description: "Runs started that day (all statuses).",
  })
  total!: number;
  @ApiProperty({
    type: "object",
    additionalProperties: { type: "number" },
    example: { completed: 38, failed: 3, running: 1 },
    description: "Run counts per status.",
  })
  byStatus!: Record<string, number>;
}

export class InsightsRunsByWorkflowResponse {
  @ApiProperty({
    type: String,
    nullable: true,
    example: "support-triage",
    description: "Workflow key; null for runs with no key (pre-migration).",
  })
  workflowKey!: string | null;
  @ApiProperty({ example: 42 }) runs!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 12840,
    description:
      "Average run duration in ms over runs with a recorded finishedAt — stamped by the worker on a normal finish, or by the API when a run is canceled (#807); null when none have one.",
  })
  avgDurationMs!: number | null;
}

export class InsightsFailureKindResponse {
  @ApiProperty({
    example: "rate_limit",
    description:
      "failureKind when recorded, else the close status (pre-feature fallback).",
  })
  kind!: string;
  @ApiProperty({ example: 3 }) count!: number;
}

export class InsightsRangeResponse {
  // No `format`, matching v1-config.response.ts's InsightsRangeResponse and for the reason recorded
  // there: these ECHO the caller's ?from/?to verbatim, which may be an ISO date ("2026-07-01") or a
  // full date-time, so pinning either would misdocument the other. It said `date-time` against a
  // plain-date example until #819's sweep touched these lines and review caught the mismatch.
  @ApiProperty({
    type: String,
    nullable: true,
    example: "2026-07-01",
    description:
      "The requested window's lower bound, echoed back (ISO 8601 date or date-time); null = unbounded.",
  })
  from!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "2026-07-31",
    description:
      "The requested window's upper bound, echoed back (ISO 8601 date or date-time); null = unbounded.",
  })
  to!: string | null;
}

/** Usage rolled up by day, environment, workflow, and model — the Insights dashboard payload. */
export class InsightsResponse {
  @ApiProperty({ type: InsightsRangeResponse })
  range!: InsightsRangeResponse;
  @ApiProperty({ type: InsightsBucketResponse })
  totals!: InsightsBucketResponse;
  @ApiProperty({ type: [InsightsByDayResponse] })
  byDay!: InsightsByDayResponse[];
  @ApiProperty({ type: [InsightsByEnvironmentResponse] })
  byEnvironment!: InsightsByEnvironmentResponse[];
  @ApiProperty({ type: [InsightsByWorkflowResponse] })
  byWorkflow!: InsightsByWorkflowResponse[];
  @ApiProperty({ type: [InsightsByModelResponse] })
  byModel!: InsightsByModelResponse[];
  @ApiProperty({ type: [InsightsByNodeTypeResponse] })
  byNodeType!: InsightsByNodeTypeResponse[];
  @ApiProperty({
    type: [InsightsRunsByDayResponse],
    description:
      "Per-day run-outcome counts from the Execution table (un-capped — fixes list-derived KPI floors).",
  })
  runsByDay!: InsightsRunsByDayResponse[];
  @ApiProperty({ type: [InsightsRunsByWorkflowResponse] })
  runsByWorkflow!: InsightsRunsByWorkflowResponse[];
  @ApiProperty({ type: [InsightsFailureKindResponse] })
  failureKinds!: InsightsFailureKindResponse[];
}
