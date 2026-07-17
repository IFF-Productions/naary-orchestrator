import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
} from "class-validator";

/**
 * Public v1 request body for starting a run. tenantId/environment are NEVER accepted here — they
 * come from the API token (+ optional X-Environment-Id header). Mirrors the internal
 * StartExecutionDto but is v1-OWNED so the public contract can't drift when the internal one changes.
 */
export class StartRunDto {
  @ApiPropertyOptional({
    example: "support-triage",
    description:
      "Which stored workflow to run (its workflowKey). Defaults to 'default'.",
  })
  @IsOptional()
  @IsString()
  workflowKey?: string;

  @ApiPropertyOptional({
    type: "object",
    additionalProperties: true,
    description: "Initial input made available to the workflow context.",
    example: { issueId: "PROJ-42" },
  })
  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;
}

/**
 * Public v1 request body for deciding a run paused on a human-approval node. One handler for both
 * outcomes: `approved:false` is a reject (design §10). tenantId comes from the token, the run id from
 * the path — never here. v1-OWNED (mirrors the internal ApproveDto).
 */
export class ApproveRunDto {
  @ApiProperty({
    example: true,
    description: "true approves the run and resumes it; false rejects it.",
  })
  @IsBoolean()
  approved!: boolean;

  @ApiPropertyOptional({
    example: "Looks good — ship it.",
    description: "Optional note recorded with the decision.",
  })
  @IsOptional()
  @IsString()
  comment?: string;
}

/**
 * Public v1 request body for re-running a past run. Empty body → re-run against the workflow's
 * current graph; `graphVersion` pins a specific saved version. v1-OWNED (mirrors the internal
 * RerunDto).
 */
export class RerunRunDto {
  @ApiPropertyOptional({
    example: 3,
    minimum: 1,
    description:
      "Saved graph version to re-run at (newer or older). Omit to use the current graph.",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  graphVersion?: number;
}
