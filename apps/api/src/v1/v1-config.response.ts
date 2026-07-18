import { ApiProperty } from "@nestjs/swagger";

/**
 * v1-OWNED response shapes for the public config API (variables, secrets, usage). Decoupled from the
 * internal VariableView/UsageSummary types: the public wire contract is additive-only within a major
 * and must NOT shift when internal types churn (design §5). Map into these in the controller — never
 * return an internal type raw.
 *
 * SECURITY (CLAUDE.md Tier-1 §4): secrets are WRITE-ONLY. No response here carries a secret value —
 * {@link SecretNameResponse} exposes the NAME only, and {@link SecretSetResponse} is a bare ack. The
 * value is decrypted only in-activity, in the worker; it never reaches an API response.
 */

export class VariableResponse {
  @ApiProperty({ example: "API_BASE_URL", description: "The `$vars.` key." })
  key!: string;
  @ApiProperty({
    example: "https://api.example.com",
    description: "The variable's value.",
  })
  value!: string;
}

export class SecretNameResponse {
  @ApiProperty({
    example: "STRIPE_KEY",
    description:
      "The `$secrets.` name. Values are write-only and never returned (Tier-1 §4).",
  })
  name!: string;
}

export class ConfigDeletedResponse {
  @ApiProperty({ example: true, description: "The entry was deleted." })
  deleted!: true;
}

export class SecretSetResponse {
  @ApiProperty({
    example: true,
    description: "The secret was stored (no value is echoed back).",
  })
  ok!: true;
}

export class UsageByModelResponse {
  @ApiProperty({ example: "anthropic" })
  provider!: string;
  @ApiProperty({ example: "claude-sonnet-4" })
  model!: string;
  @ApiProperty({ example: 12, description: "Number of metered calls." })
  calls!: number;
  @ApiProperty({ example: 34567 })
  totalTokens!: number;
  @ApiProperty({ example: 0.4213, description: "USD cost for this model." })
  costUsd!: number;
}

export class UsageEventResponse {
  @ApiProperty({ description: "Usage-ledger row id." })
  id!: string;
  @ApiProperty({ description: "The run this spend belongs to." })
  executionId!: string;
  @ApiProperty({ description: "The node that made the call." })
  nodeId!: string;
  @ApiProperty({ example: "anthropic" })
  provider!: string;
  @ApiProperty({ example: "claude-sonnet-4" })
  model!: string;
  @ApiProperty({ example: 1200 })
  inputTokens!: number;
  @ApiProperty({ example: 340 })
  outputTokens!: number;
  @ApiProperty({ example: 1540 })
  totalTokens!: number;
  @ApiProperty({ example: 0.018 })
  costUsd!: number;
  @ApiProperty({ format: "date-time", example: "2026-07-04T12:00:00.000Z" })
  createdAt!: string;
}

/**
 * Aggregated + line-item spend for the token's tenant, optionally windowed by ?from&to. Tokens + cost
 * only — the ledger never stores prompt/completion text, and neither does this DTO (privacy invariant).
 */
export class UsageResponse {
  @ApiProperty({ example: 1.2345, description: "Total USD across the window." })
  totalCostUsd!: number;
  @ApiProperty({
    example: 123456,
    description: "Total tokens across the window.",
  })
  totalTokens!: number;
  @ApiProperty({
    type: [UsageByModelResponse],
    description: "Per-model rollup.",
  })
  byModel!: UsageByModelResponse[];
  @ApiProperty({
    type: [UsageEventResponse],
    description: "Per-call line items (newest first). Tokens + cost only.",
  })
  events!: UsageEventResponse[];
}

// ---- Insights (usage rolled up by day / environment / workflow / model) -------------------------

/** The cost/tokens/calls totals shared by every insights bucket. */
export class InsightsBucketResponse {
  @ApiProperty({ example: 0.4213 })
  costUsd!: number;
  @ApiProperty({ example: 34567 })
  totalTokens!: number;
  @ApiProperty({ example: 12, description: "Number of metered calls." })
  calls!: number;
}

export class InsightsByDayResponse extends InsightsBucketResponse {
  @ApiProperty({
    format: "date",
    example: "2026-07-16",
    description: "UTC calendar day (YYYY-MM-DD).",
  })
  date!: string;
}

export class InsightsByEnvironmentResponse extends InsightsBucketResponse {
  @ApiProperty({
    nullable: true,
    example: "env-prod",
    description: "Environment id; null for spend recorded before env tagging.",
  })
  environmentId!: string | null;
}

export class InsightsByWorkflowResponse extends InsightsBucketResponse {
  @ApiProperty({
    nullable: true,
    example: "support-triage",
    description: "Workflow key; null for runs with no key (pre-migration).",
  })
  workflowKey!: string | null;
}

export class InsightsRangeResponse {
  // No `format`: these ECHO the caller's ?from/?to verbatim, which may be an ISO date
  // ("2026-07-01") or a full date-time — pinning either format would misdocument the other.
  @ApiProperty({
    nullable: true,
    example: "2026-07-01",
    description:
      "The requested window's lower bound, echoed back (ISO 8601 date or date-time); null = unbounded.",
  })
  from!: string | null;
  @ApiProperty({
    nullable: true,
    example: "2026-07-31",
    description:
      "The requested window's upper bound, echoed back (ISO 8601 date or date-time); null = unbounded.",
  })
  to!: string | null;
}

/**
 * Usage rolled up by day (time-series), environment, workflow, and model for the token's tenant —
 * optionally windowed by ?from&to and scoped to one ?environmentId. Tokens + cost only (privacy).
 */
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
  @ApiProperty({ type: [UsageByModelResponse] })
  byModel!: UsageByModelResponse[];
}
