import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsObject, IsOptional, IsString } from "class-validator";

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
