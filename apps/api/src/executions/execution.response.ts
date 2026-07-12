import { ApiProperty } from "@nestjs/swagger";

/** Result of starting a run — the Temporal workflowId to poll/approve against. */
export class StartExecutionResponse {
  @ApiProperty({
    example: "run-8f3a1c2e",
    description: "Temporal workflowId of the started run.",
  })
  workflowId!: string;
}

/** One row in the recent-runs list (newest first). */
export class RunListItemResponse {
  @ApiProperty({ example: "run-8f3a1c2e" }) workflowId!: string;
  @ApiProperty({ format: "date-time", example: "2026-07-04T12:00:00.000Z" })
  createdAt!: string;
}

/** A run paused for approval, enriched with the humanApproval node's prompt. */
export class AwaitingApprovalResponse {
  @ApiProperty({ example: "run-8f3a1c2e" }) workflowId!: string;
  @ApiProperty({ nullable: true, example: "support-triage" })
  workflowKey!: string | null;
  @ApiProperty({ example: "approve-summary" }) nodeId!: string;
  @ApiProperty({ example: "Approve the drafted summary" }) title!: string;
  @ApiProperty({
    nullable: true,
    example: "Review the summary before it is emailed.",
  })
  instructions!: string | null;
  @ApiProperty({ format: "date-time", example: "2026-07-04T12:00:00.000Z" })
  createdAt!: string;
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
    nullable: true,
    format: "date-time",
    example: "2026-07-04T12:00:00.000Z",
  })
  at!: string | null;
  @ApiProperty({ required: false, example: "Provider returned 429" })
  detail?: string;
}
