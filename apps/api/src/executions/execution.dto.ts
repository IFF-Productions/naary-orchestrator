import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
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
