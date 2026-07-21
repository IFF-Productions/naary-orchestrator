import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/** One organizational tag chip on a workflow row (tags are never permissions). */
export class GraphTagResponse {
  @ApiProperty({ example: "9a8b7c6d-…" }) id!: string;
  @ApiProperty({ example: "production" }) name!: string;
  @ApiProperty({ nullable: true, example: "#6366f1" }) color!: string | null;
}

/** One row in the workflows list (latest version per key). */
export class GraphSummaryResponse {
  @ApiProperty({ example: "support-triage" }) workflowKey!: string;
  @ApiProperty({ example: "Support triage" }) name!: string;
  @ApiProperty({ example: 3 }) version!: number;
  @ApiProperty({ required: false, format: "date-time" }) updatedAt?: string;
  @ApiProperty({
    example: true,
    description: "Whether automatic triggers fire.",
  })
  active!: boolean;
  @ApiProperty({
    type: [GraphTagResponse],
    description:
      "Organizational tags (tenant-wide per workflowKey, identical in every environment).",
  })
  tags!: GraphTagResponse[];
}

/** A generated draft graph (unsaved). */
export class GenerateGraphResponse {
  @ApiProperty({ example: "Support triage" }) name!: string;
  @ApiProperty({ type: "object", additionalProperties: true }) graph!: Record<
    string,
    unknown
  >;
}

/** The latest graph for a key (opened in the canvas). */
export class GraphDetailResponse {
  @ApiProperty() workflowKey!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ example: 3 }) version!: number;
  @ApiProperty({ type: "object", additionalProperties: true }) graph!: Record<
    string,
    unknown
  >;
}

/** Result of saving (versioning) a graph. */
export class SaveGraphResponse {
  @ApiProperty() workflowKey!: string;
  @ApiProperty({ example: 4 }) version!: number;
  @ApiProperty({ description: "sha256 of the canonical graph." })
  contentHash!: string;
}

/** One stored version of a workflow (identity only, no graph body). */
export class GraphVersionResponse {
  @ApiProperty({ example: 3 }) version!: number;
  @ApiProperty({ description: "sha256 of the canonical graph." })
  contentHash!: string;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
  @ApiPropertyOptional({
    type: "string",
    nullable: true,
    example: "ada@acme.io",
    description:
      "Who saved this version (email / 'api-token'); null for promoted or pre-feature rows (#488).",
  })
  savedBy!: string | null;
  @ApiPropertyOptional({
    type: "string",
    nullable: true,
    example: "Add retry to the HTTP node",
    description:
      "Optional commit note recorded on save; null when none (#488).",
  })
  saveMessage!: string | null;
}

/** A workflow's bound error-handler key (null = none). */
export class ErrorHandlerResponse {
  @ApiProperty({ nullable: true, example: "on-failure-alert" })
  errorWorkflowKey!: string | null;
}

/** Result of promoting a workflow definition into a target env. */
export class PromoteGraphResponse {
  @ApiProperty({ example: 5, description: "Source version promoted." })
  fromVersion!: number;
  @ApiProperty({
    example: 3,
    description:
      "Version in the target env (a new version, or an existing one if the graph was identical).",
  })
  toVersion!: number;
  @ApiProperty({ description: "sha256 of the promoted graph." })
  contentHash!: string;
}

/** One promotion in a workflow's lineage/audit history. */
export class PromotionResponse {
  @ApiProperty() fromEnvId!: string;
  @ApiProperty() toEnvId!: string;
  @ApiProperty({ example: 5 }) fromVersion!: number;
  @ApiProperty({ example: 3 }) toVersion!: number;
  @ApiProperty({
    example: "auth0|abc",
    description: "OIDC subject or 'api-token'.",
  })
  actor!: string;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
}
