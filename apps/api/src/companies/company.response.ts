import { ApiProperty } from "@nestjs/swagger";

/** One company the caller belongs to (COMPANIES.md Slice 1). */
export class CompanyViewResponse {
  @ApiProperty({ example: "9f1c…" }) id!: string;
  @ApiProperty({ example: "Acme Holdings" }) name!: string;
  @ApiProperty({ example: "acme-holdings-a1b2c3" }) slug!: string;
  @ApiProperty({
    example: "owner",
    enum: ["owner", "admin"],
    description: "The caller's role in this company.",
  })
  role!: string;
}

// ---- Company budget (COMPANIES.md §8, Slice 5) --------------------------------------------------

/** The persisted company-wide budget config. */
export class CompanyBudgetConfigResponse {
  @ApiProperty({
    example: 500,
    description:
      "Company-wide monthly spend cap, USD, summed across all member workspaces.",
  })
  monthlyCapUsd!: number;
  @ApiProperty({
    example: "reject",
    enum: ["reject"],
    description: "Action when the company cap is exceeded.",
  })
  onBudgetExceeded!: string;
}

/** Company budget config (null when unset) + live company-wide month-to-date spend. */
export class CompanyBudgetViewResponse {
  @ApiProperty({ type: CompanyBudgetConfigResponse, nullable: true })
  budget!: CompanyBudgetConfigResponse | null;
  @ApiProperty({
    example: 42.5,
    description: "Company-wide month-to-date spend, USD.",
  })
  mtdSpendUsd!: number;
  @ApiProperty({
    nullable: true,
    example: 457.5,
    description:
      "monthlyCapUsd − mtdSpendUsd (may be negative); null when no budget is configured.",
  })
  remainingUsd!: number | null;
}

// ---- Company usage rollup (COMPANIES.md §5, Slice 2) --------------------------------------------

/** The cost/tokens/calls totals shared by every company-usage bucket. Tokens + cost only. */
export class CompanyUsageBucketResponse {
  @ApiProperty({ example: 0.4213 })
  costUsd!: number;
  @ApiProperty({ example: 34567 })
  totalTokens!: number;
  @ApiProperty({ example: 12, description: "Number of metered calls." })
  calls!: number;
}

export class CompanyUsageEnvironmentResponse extends CompanyUsageBucketResponse {
  @ApiProperty({
    nullable: true,
    example: "env-prod",
    description: "Environment id; null for spend recorded before env tagging.",
  })
  environmentId!: string | null;
}

export class CompanyUsageWorkspaceResponse extends CompanyUsageBucketResponse {
  @ApiProperty({ example: "t-acme" })
  tenantId!: string;
  @ApiProperty({
    nullable: true,
    example: "Acme Production",
    description: "The workspace's display name; null if it has none.",
  })
  displayName!: string | null;
  @ApiProperty({
    type: [CompanyUsageEnvironmentResponse],
    description:
      "Per-environment breakdown within this workspace, highest spend first.",
  })
  byEnvironment!: CompanyUsageEnvironmentResponse[];
}

export class CompanyUsageRangeResponse {
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
 * Company-wide usage rollup: total + per-workspace (+ nested per-environment) spend across the
 * company's member workspaces. Read-only; every member workspace is listed, even with zero spend.
 */
export class CompanyUsageResponse {
  @ApiProperty({ type: CompanyUsageRangeResponse })
  range!: CompanyUsageRangeResponse;
  @ApiProperty({ type: CompanyUsageBucketResponse })
  totals!: CompanyUsageBucketResponse;
  @ApiProperty({
    type: [CompanyUsageWorkspaceResponse],
    description: "Per-workspace rollup, highest spend first.",
  })
  byWorkspace!: CompanyUsageWorkspaceResponse[];
}

// ---- Slice 3: cross-workspace visibility (READ-ONLY) --------------------------------------------

/** One run summary row as the console sees it (mirror of the runs list item — no detail). */
export class CompanyWorkspaceRunItemResponse {
  @ApiProperty({ description: "Run id (Temporal workflowId)." })
  workflowId!: string;
  @ApiProperty({ nullable: true, description: "The workflow's key." })
  workflowKey!: string | null;
  @ApiProperty({ example: "completed" })
  status!: string;
  @ApiProperty({ format: "date-time" })
  createdAt!: string;
}

/** Keyset page of a member workspace's runs. */
export class CompanyWorkspaceRunsResponse {
  @ApiProperty({ type: [CompanyWorkspaceRunItemResponse] })
  items!: CompanyWorkspaceRunItemResponse[];
  @ApiProperty({
    nullable: true,
    description: "Opaque cursor for the next page; null = end.",
  })
  nextCursor!: string | null;
}

/** Workflow summary (name/key/version — never the graph body) from the workspace's default env. */
export class CompanyWorkspaceWorkflowResponse {
  @ApiProperty()
  workflowKey!: string;
  @ApiProperty({ description: "Whether automatic triggers fire." })
  active!: boolean;
  @ApiProperty()
  name!: string;
  @ApiProperty()
  version!: number;
  @ApiProperty({ format: "date-time" })
  updatedAt!: string;
}
