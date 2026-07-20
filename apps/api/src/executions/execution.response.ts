import { ApiProperty } from "@nestjs/swagger";

/** Result of starting a run — the Temporal workflowId to poll/approve against. */
export class StartExecutionResponse {
  @ApiProperty({
    example: "run-8f3a1c2e",
    description: "Temporal workflowId of the started run.",
  })
  workflowId!: string;
}

/** One row in the recent-runs list (newest first). Mirrors the service's RunSummary — the
 *  live status/cost are projected onto the row, not just identity + time. */
export class RunListItemResponse {
  @ApiProperty({ example: "run-8f3a1c2e" }) workflowId!: string;
  @ApiProperty({ type: String, nullable: true, example: "support-triage" })
  workflowKey!: string | null;
  @ApiProperty({
    example: "completed",
    description:
      "App status or a Temporal close reason (failed | timed_out | terminated | canceled | unknown).",
  })
  status!: string;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 0.0142,
    description: "Run cost in USD.",
  })
  costUsd!: number | null;
  @ApiProperty({ format: "date-time", example: "2026-07-04T12:00:00.000Z" })
  startedAt!: string;
  @ApiProperty({ format: "date-time", example: "2026-07-04T12:00:00.000Z" })
  createdAt!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    format: "date-time",
    description:
      "When the run reached a terminal status (worker-stamped); null for in-flight runs and runs predating the stamp.",
  })
  finishedAt!: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 12840,
    description:
      "finishedAt − createdAt in ms; null whenever finishedAt is null (never derived from now).",
  })
  durationMs!: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "rate_limit",
    description:
      "Compact failure classification on terminal failures (timeout | upstream_5xx | rate_limit | budget | rejected | error); null → fall back to the status.",
  })
  failureKind!: string | null;
  @ApiProperty({
    example: false,
    description: "Soft-archived (hidden by default).",
  })
  archived!: boolean;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 3,
    description:
      "The workflow graph version this run snapshotted at start; null for pre-migration rows.",
  })
  graphVersion!: number | null;
}

/** One approver group on an awaiting row (display summary). */
export class ApproverGroupResponse {
  @ApiProperty({ example: "9f3a…" }) id!: string;
  @ApiProperty({ example: "finance-leads" }) name!: string;
}

/** Who may decide a routed approval gate (display summary; enforced on approve). */
export class ApproverSummaryResponse {
  @ApiProperty({ type: [String], example: ["sam@acme.io"] })
  emails!: string[];
  @ApiProperty({ type: [ApproverGroupResponse] })
  groups!: ApproverGroupResponse[];
}

/** A run paused for approval, enriched with the humanApproval node's prompt and the
 *  pause-time routing/SLA/context snapshot (null when the gate has none). */
export class AwaitingApprovalResponse {
  @ApiProperty({ example: "run-8f3a1c2e" }) workflowId!: string;
  @ApiProperty({ type: String, nullable: true, example: "support-triage" })
  workflowKey!: string | null;
  @ApiProperty({ example: "approve-summary" }) nodeId!: string;
  @ApiProperty({ example: "Approve the drafted summary" }) title!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "Review the summary before it is emailed.",
  })
  instructions!: string | null;
  @ApiProperty({ format: "date-time", example: "2026-07-04T12:00:00.000Z" })
  createdAt!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    format: "date-time",
    description: "When the gate paused (worker clock at pause time).",
  })
  pausedAt!: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 48,
    description: "The gate's display-only SLA in hours.",
  })
  slaHours!: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    format: "date-time",
    description:
      "pausedAt + slaHours (server-derived); null unless both exist.",
  })
  dueAt!: string | null;
  @ApiProperty({
    type: "object",
    additionalProperties: { type: "string" },
    nullable: true,
    description:
      "Structured context card — expressions resolved at pause time (never secrets).",
  })
  contextFields!: Record<string, string> | null;
  @ApiProperty({ type: ApproverSummaryResponse, nullable: true })
  approvers!: ApproverSummaryResponse | null;
  @ApiProperty({ type: Number, nullable: true, example: 20 })
  escalateAfterHours!: number | null;
  @ApiProperty({ type: String, nullable: true, example: "@ops-oncall" })
  escalateTo!: string | null;
}

/** Outcome of a manual "Remind now" — how many channels were POSTed. */
export class RemindResponse {
  @ApiProperty({ example: true }) accepted!: boolean;
  @ApiProperty({
    example: 2,
    description:
      "How many notification channels the reminder was delivered to.",
  })
  sent!: number;
}

/** Acknowledgement that an approval decision was accepted (async, 202). */
export class AcceptedResponse {
  @ApiProperty({ example: true }) accepted!: boolean;
}

/** Per-run outcome of a batch approve/reject. `ok:false` runs were already closed or not
 *  owned by the tenant; they don't fail the batch — the caller can show which ones slipped. */
export class BatchDecisionItemResponse {
  @ApiProperty({ example: "run-8f3a1c2e" }) workflowId!: string;
  @ApiProperty({ example: true }) ok!: boolean;
  @ApiProperty({
    type: String,
    required: false,
    nullable: true,
    example:
      "Execution is not awaiting approval (already completed, rejected, or failed).",
    description: "Why this run wasn't decided (present only when ok is false).",
  })
  error?: string | null;
}

/** The resume-URL path for a run paused on a wait(webhook) node (host prepended client-side). */
export class ResumeUrlResponse {
  @ApiProperty({
    example: "/hooks/resume/run-8f3a1c2e?token=ab12…",
    description:
      "Relative path an external system POSTs to resume the run. The token is the credential.",
  })
  path!: string;
}

/** Live run detail — status, current node, and the accumulated context. */
export class RunStateResponse {
  @ApiProperty({
    example: "running",
    description:
      "App status or a Temporal close reason (failed | timed_out | terminated | canceled | unknown).",
  })
  status!: string;
  @ApiProperty({ example: "agent-1" }) currentNodeId!: string;
  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description: "Accumulated workflow context.",
  })
  ctx!: Record<string, unknown>;
  @ApiProperty({
    type: "object",
    additionalProperties: true,
    nullable: true,
    description:
      "Per-node timing map (Slice 2): { [nodeId]: { s, f, n?, totalMs? } } — epoch-ms start/finish stamped with deterministic workflow time; n/totalMs aggregate repeated passes (loops). Null when the run predates the feature or its ctx is unavailable.",
  })
  nodeTimes!: Record<string, unknown> | null;
}

/** The graph snapshot a run executed — for the run-detail canvas (read-only). */
export class RunGraphResponse {
  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description:
      "The version-pinned GraphDef the run walked (nodes, edges, startNodeId).",
  })
  graph!: Record<string, unknown>;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 3,
    description:
      "The workflow graph version this run executed; null for pre-migration runs.",
  })
  version!: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "support-triage",
    description:
      "The run's workflowKey (drives the re-run-at-version picker); null for very old runs.",
  })
  workflowKey!: string | null;
}

/** One entry in a run's execution log (derived from Temporal history). */
export class RunEventResponse {
  @ApiProperty({ example: 12 }) id!: number;
  @ApiProperty({
    enum: [
      "started",
      "activity",
      "signal",
      "timer",
      "completed",
      "error",
      "continued",
    ],
    example: "activity",
    description: "Coarse kind for the UI icon/colour.",
  })
  kind!: string;
  @ApiProperty({ example: "Activity: callAgent" }) label!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    format: "date-time",
    example: "2026-07-04T12:00:00.000Z",
  })
  at!: string | null;
  @ApiProperty({ required: false, example: "Provider returned 429" })
  detail?: string;
}
