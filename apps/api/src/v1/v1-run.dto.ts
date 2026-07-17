import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsObject, IsOptional, IsString } from "class-validator";

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
