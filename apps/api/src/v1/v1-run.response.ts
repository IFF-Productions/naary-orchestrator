import { ApiProperty } from "@nestjs/swagger";

/**
 * v1-OWNED response shapes for the public run API. Deliberately decoupled from the internal
 * RunSummary/RunStateView/RunEvent (executions.service.ts): the public wire contract is additive-only
 * within a major and must NOT shift when the SPA-facing internal types churn (design §5). The product
 * word is "run" (`runId`), not the internal "execution"/"workflowId", and internal-only fields
 * (e.g. `archived`) are omitted. Map into these in the controller — never return an internal type raw.
 */

export class RunRefResponse {
  @ApiProperty({
    example: "run-8f3a1c2e",
    description: "The started run's id.",
  })
  runId!: string;
}

export class RunListItemResponse {
  @ApiProperty({ example: "run-8f3a1c2e" })
  runId!: string;
  @ApiProperty({ nullable: true, example: "support-triage" })
  workflowKey!: string | null;
  @ApiProperty({
    example: "completed",
    description:
      "Run status: running | awaiting_approval | completed | rejected | budget_exceeded | circuit_open | invalid_graph, or a Temporal close reason (failed | timed_out | terminated | canceled | unknown).",
  })
  status!: string;
  @ApiProperty({
    nullable: true,
    example: 0.0142,
    description: "Run cost in USD.",
  })
  costUsd!: number | null;
  @ApiProperty({ format: "date-time", example: "2026-07-04T12:00:00.000Z" })
  startedAt!: string;
  @ApiProperty({
    nullable: true,
    example: 3,
    description:
      "Workflow graph version this run snapshotted at start; null for older runs.",
  })
  graphVersion!: number | null;
}

export class RunDetailResponse {
  @ApiProperty({ example: "run-8f3a1c2e" })
  runId!: string;
  @ApiProperty({ example: "running" })
  status!: string;
  @ApiProperty({
    example: "node-3",
    description: "The node the run is currently at (or last completed).",
  })
  currentNodeId!: string;
  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description:
      "The run's output context — each node's result keyed by node id.",
  })
  output!: Record<string, unknown>;
}

export class RunHistoryEventResponse {
  @ApiProperty({ example: 12 })
  id!: number;
  @ApiProperty({
    example: "activity",
    description:
      "started | activity | signal | timer | completed | error | continued.",
  })
  kind!: string;
  @ApiProperty({ example: "callHttpRequest" })
  label!: string;
  @ApiProperty({
    nullable: true,
    format: "date-time",
    example: "2026-07-04T12:00:01.000Z",
  })
  at!: string | null;
  @ApiProperty({ required: false, example: "GET api.example.com → 200" })
  detail?: string;
}
