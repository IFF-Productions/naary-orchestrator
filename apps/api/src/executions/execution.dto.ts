import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
} from "class-validator";

export class StartExecutionDto {
  // tenantId is NOT accepted from the client — it is derived from the API token.
  @ApiPropertyOptional({
    type: "object",
    additionalProperties: true,
    description: "Initial input available to the workflow context.",
    example: { issueId: "PROJ-42" },
  })
  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;

  // Which stored graph to run (its workflowKey). Defaults to "default" so existing
  // callers are unchanged; the canvas saves under "canvas" and runs that.
  @ApiPropertyOptional({
    example: "support-triage",
    description:
      "Which stored graph to run (its workflowKey). Defaults to 'default'.",
  })
  @IsOptional()
  @IsString()
  workflowKey?: string;

  @ApiPropertyOptional({
    example: true,
    description:
      "Diagnostics for THIS run only (off by default). Two effects: (1) the worker logs this run's activities at DEBUG level (others stay at LOG_LEVEL) — filter the logs by the returned workflowId; (2) the run's Execution log in the app gains one row per executed node with its timing and non-content metadata (model, tokens, cost, HTTP status). Never records prompts, outputs or values.",
  })
  @IsOptional()
  @IsBoolean()
  debug?: boolean;
}

/** Re-run a past run. By default re-runs against the workflow's LATEST graph; pass
 *  `graphVersion` to re-run at a specific saved version (of the run's own workflow). */
export class RerunDto {
  @ApiPropertyOptional({
    example: 2,
    description:
      "A specific saved version of this run's workflow to re-run at (newer or older). Omit to re-run against the latest.",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  graphVersion?: number;

  @ApiPropertyOptional({
    example: true,
    description:
      "Re-run with diagnostics on (off by default) — same meaning as `debug` on POST /executions, applied to the NEW run. The original run's flag is not inherited: a run you now want to understand is re-run with this set.",
  })
  @IsOptional()
  @IsBoolean()
  debug?: boolean;
}

/** Body for POST :id/resume — resume a failed run at the node that failed. */
export class ResumeRunDto {
  @ApiPropertyOptional({
    example: true,
    description:
      "Required only when the failing node is one that may already have taken effect (sqlExec, sendEmail, code, codeAgent, integration). It FAILED, but failing is not the same as having had no effect — a write can succeed and then the response time out. Resuming re-runs that node, so the caller has to say they accept a possible duplicate. Omitted for such a node ⇒ 400.",
  })
  @IsOptional()
  @IsBoolean()
  acknowledgeSideEffects?: boolean;
}

export class ApproveDto {
  @ApiProperty({
    example: true,
    description: "true to approve, false to reject the paused run.",
  })
  @IsBoolean()
  approved!: boolean;

  /** Optional reviewer note recorded with the decision (approve or reject). */
  @ApiPropertyOptional({
    example: "Looks good, ship it.",
    description: "Reviewer note recorded with the decision.",
  })
  @IsOptional()
  @IsString()
  comment?: string;
}

/** Decide many paused runs in one call — same decision (approve OR reject) applied to each. */
export class ApproveBatchDto {
  @ApiProperty({
    type: [String],
    example: ["run-8f3a1c2e", "run-1b7d9f04"],
    description: "workflowIds of the paused runs to decide together.",
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  ids!: string[];

  @ApiProperty({
    example: true,
    description: "true to approve every listed run, false to reject every one.",
  })
  @IsBoolean()
  approved!: boolean;

  /** Optional reviewer note recorded with every decision in the batch. */
  @ApiPropertyOptional({
    example: "Batch-approved after review.",
    description: "Reviewer note recorded with every decision in the batch.",
  })
  @IsOptional()
  @IsString()
  comment?: string;
}

export class ArchiveBatchDto {
  @ApiProperty({
    type: [String],
    example: ["run-8f3a1c2e", "run-1b7d9f04"],
    description: "workflowIds of the runs to archive/restore together.",
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  ids!: string[];

  @ApiProperty({
    example: true,
    description: "true archives every listed run, false restores every one.",
  })
  @IsBoolean()
  archived!: boolean;
}

export class CancelBatchDto {
  @ApiProperty({
    type: [String],
    example: ["run-8f3a1c2e", "run-1b7d9f04"],
    description: "workflowIds of the running/paused runs to cancel together.",
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  ids!: string[];
}
