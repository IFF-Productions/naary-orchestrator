import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsInt,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
} from "class-validator";

/**
 * Public v1 body for creating/updating a workflow (`PUT /v1/workflows/:key`) — also the "import"
 * target: POST the same document you got from `GET /v1/workflows/:key`. The workflowKey is the path
 * param, never the body; tenantId/environment come from the token (+ optional X-Environment-Id).
 * v1-OWNED so the public contract can't drift when the internal SaveGraphDto changes.
 */
export class ImportWorkflowDto {
  @ApiProperty({
    example: "Support triage",
    description: "Human-readable name.",
  })
  @IsString()
  name!: string;

  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description:
      "The workflow graph: { nodes: [], edges: [], startNodeId }. Validated on save (400 if malformed).",
    example: { nodes: [], edges: [], startNodeId: "start" },
  })
  @IsObject()
  graph!: Record<string, unknown>;
}

/**
 * Public v1 body for promoting a workflow from the active env into another (`POST
 * /v1/workflows/:key/promote`). Copies the graph only — credentials/connections bind per-env and are
 * never copied. v1-OWNED (mirrors the internal PromoteGraphDto).
 */
export class PromoteWorkflowDto {
  @ApiProperty({
    example: "prod",
    description: "Target environment id or slug to promote into.",
  })
  @IsString()
  toEnv!: string;

  @ApiPropertyOptional({
    example: 5,
    minimum: 1,
    description:
      "Source version to promote (from the active env). Omit to promote the latest.",
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  fromVersion?: number;
}
