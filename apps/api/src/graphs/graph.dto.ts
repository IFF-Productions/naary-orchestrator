import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsInt,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

/** Generate a draft graph from a plain-English description (AI workflow builder).
 *  Bounded length keeps the model prompt sane and blocks abuse. */
export class GenerateGraphDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 2000,
    example:
      "When a webhook arrives, have an agent summarize it, wait for my approval, then email the summary.",
    description: "Plain-English description of the workflow to build.",
  })
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  prompt!: string;

  @ApiPropertyOptional({
    enum: ["anthropic", "openai", "google", "claude-code"],
    description:
      "Provider to generate with. Omitted ⇒ the tenant's first configured+valid model provider, falling back to the Claude Code credential (subscription-billed, via the headless CLI).",
  })
  @IsOptional()
  @IsString()
  provider?: string;
}

/** Save a graph for a tenant under a stable workflowKey. The `graph` is validated
 *  in depth by `validateGraph` inside GraphsService.upsert (400 on a bad graph);
 *  here we only assert it's an object — the controller checks the top-level shape. */
export class SaveGraphDto {
  @ApiProperty({
    example: "support-triage",
    description: "Stable key the workflow is stored + run under.",
  })
  @IsString()
  workflowKey!: string;

  @ApiProperty({ example: "Support triage" })
  @IsString()
  name!: string;

  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description: "The graph: { nodes, edges, startNodeId }.",
  })
  @IsObject()
  graph!: Record<string, unknown>;
}

/** Promote a workflow's definition from the ACTIVE env (X-Environment-Id) to a target env. */
export class PromoteGraphDto {
  @ApiProperty({
    example: "prod",
    description: "Target environment id or slug to promote INTO.",
  })
  @IsString()
  toEnv!: string;

  @ApiPropertyOptional({
    example: 3,
    description:
      "Source version to promote (default: the source env's latest version).",
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  fromVersion?: number;
}
