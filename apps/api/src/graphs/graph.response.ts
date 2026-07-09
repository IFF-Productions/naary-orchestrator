import { ApiProperty } from "@nestjs/swagger";

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

/** A workflow's bound error-handler key (null = none). */
export class ErrorHandlerResponse {
  @ApiProperty({ nullable: true, example: "on-failure-alert" })
  errorWorkflowKey!: string | null;
}
