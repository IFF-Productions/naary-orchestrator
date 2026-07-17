import { ApiProperty } from "@nestjs/swagger";

/**
 * v1-OWNED response shapes for the public workflows API. Decoupled from the internal
 * GraphSummary/GraphSnapshot/Promotion types (graphs.service.ts): the public wire contract is
 * additive-only within a major and must NOT shift when internal types churn (design §5). The product
 * word is "workflow" (keyed by `workflowKey`), not the internal "graph". Map into these in the
 * controller — never return an internal type raw.
 */

export class WorkflowSummaryResponse {
  @ApiProperty({ example: "support-triage" })
  workflowKey!: string;
  @ApiProperty({ example: "Support triage" })
  name!: string;
  @ApiProperty({ example: 4, description: "Latest saved version." })
  version!: number;
  @ApiProperty({ format: "date-time", example: "2026-07-04T12:00:00.000Z" })
  updatedAt!: string;
  @ApiProperty({
    example: true,
    description: "Whether the workflow's automatic triggers fire (n8n parity).",
  })
  active!: boolean;
}

export class WorkflowExportResponse {
  @ApiProperty({ example: "support-triage" })
  workflowKey!: string;
  @ApiProperty({ example: "Support triage" })
  name!: string;
  @ApiProperty({
    example: 4,
    description: "The version this document reflects.",
  })
  version!: number;
  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description:
      "The full workflow graph ({ nodes, edges, startNodeId }). Round-trips: PUT this back to import.",
  })
  graph!: Record<string, unknown>;
}

export class WorkflowSavedResponse {
  @ApiProperty({ example: "support-triage" })
  workflowKey!: string;
  @ApiProperty({
    example: 5,
    description:
      "The saved version (a new version, or the existing one if the graph was unchanged).",
  })
  version!: number;
  @ApiProperty({ description: "sha256 of the saved graph." })
  contentHash!: string;
}

export class WorkflowDeletedResponse {
  @ApiProperty({ example: true, description: "The workflow was deleted." })
  deleted!: true;
}

export class WorkflowPromotionResponse {
  @ApiProperty({ example: 5, description: "Source version promoted." })
  fromVersion!: number;
  @ApiProperty({
    example: 3,
    description:
      "Version created in the target env (or an existing one if the graph was identical).",
  })
  toVersion!: number;
  @ApiProperty({ description: "sha256 of the promoted graph." })
  contentHash!: string;
}

export class PromotionLineageResponse {
  @ApiProperty({ description: "Source environment id." })
  fromEnvId!: string;
  @ApiProperty({ description: "Target environment id." })
  toEnvId!: string;
  @ApiProperty({ example: 5 })
  fromVersion!: number;
  @ApiProperty({ example: 3 })
  toVersion!: number;
  @ApiProperty({
    example: "auth0|abc",
    description: "OIDC subject of the promoter, or 'api-token'.",
  })
  actor!: string;
  @ApiProperty({ format: "date-time", example: "2026-07-04T12:00:00.000Z" })
  createdAt!: string;
}
