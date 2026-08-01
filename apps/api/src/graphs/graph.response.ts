import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/** One organizational tag chip on a workflow row (tags are never permissions). */
export class GraphTagResponse {
  @ApiProperty({ example: "9a8b7c6d-…" }) id!: string;
  @ApiProperty({ example: "production" }) name!: string;
  @ApiProperty({ type: String, nullable: true, example: "#6366f1" }) color!:
    string | null;
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
    type: String,
    nullable: true,
    example: "formTrigger",
    description:
      "Node type of the graph's entry node (startNodeId), or null if unresolvable. Hosted-endpoint registration requires a matching entry node, so clients can use this to offer only eligible workflows.",
  })
  entryType!: string | null;
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

/** One node's honest translation record from an n8n import (#579). */
export class N8nNodeReportResponse {
  @ApiProperty({
    example: "High value?",
    description: "The node's name in n8n.",
  })
  n8nName!: string;
  @ApiProperty({ example: "n8n-nodes-base.if" }) n8nType!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "high-value",
    description:
      "Our node id in the draft graph. Null when the node is intentionally NOT a graph node " +
      "(`skipped`: an n8n sticky note, a disabled node, or an AI sub-node).",
  })
  nodeId!: string | null;
  @ApiProperty({ type: String, nullable: true, example: "if" })
  nodeType!: string | null;
  @ApiProperty({
    example: "imported",
    enum: ["imported", "approximated", "unmapped", "skipped"],
    description:
      "`imported` = faithful. `approximated` = runs, but something was reshaped. `unmapped` = no " +
      "equivalent, so it became a noOp placeholder carrying its original n8n config under " +
      "`__n8n`. `skipped` = deliberately not a graph node.",
  })
  status!: string;
  @ApiProperty({
    type: [String],
    description:
      "What was lost or is left to do. Always non-empty unless status is `imported`.",
  })
  notes!: string[];
}

/** A credential TYPE the n8n workflow used. Never an id, an account name, or a secret. */
export class N8nCredentialReportResponse {
  @ApiProperty({ example: "httpHeaderAuth" }) n8nType!: string;
  @ApiProperty({ type: [String], description: "n8n node names that used it." })
  usedBy!: string[];
  @ApiProperty({
    type: String,
    nullable: true,
    example: "custom",
    description:
      "The connection type to create here, or null when we have no equivalent.",
  })
  suggestedConnectionType!: string | null;
}

/** One n8n expression we could not translate. */
export class N8nUnconvertedExpressionResponse {
  @ApiProperty({ example: "high-value" }) nodeId!: string;
  @ApiProperty({ example: "subject" }) field!: string;
  @ApiProperty({ example: "{{ $now.toISO() }}" }) expression!: string;
  @ApiProperty({
    example: "n8n's $now is a DateTime object; use a dateTime node instead",
  })
  reason!: string;
}

/**
 * An imported n8n workflow: an UNSAVED draft graph plus the mapping report (#579).
 *
 * Save it with `POST /graphs` once credentials have been reconnected — there is no draft state in
 * the schema, so saving creates version 1.
 */
export class ImportN8nResponse {
  @ApiProperty({ example: "Order webhook triage" }) name!: string;
  @ApiProperty({
    type: "object",
    additionalProperties: true,
    description: "The draft graph { nodes, edges, startNodeId }. Not saved.",
  })
  graph!: Record<string, unknown>;
  @ApiProperty({
    type: [N8nNodeReportResponse],
    description:
      "One entry per node in the export — nothing is dropped silently.",
  })
  nodes!: N8nNodeReportResponse[];
  @ApiProperty({ type: [N8nCredentialReportResponse] })
  credentials!: N8nCredentialReportResponse[];
  @ApiProperty({ type: [N8nUnconvertedExpressionResponse] })
  unconvertedExpressions!: N8nUnconvertedExpressionResponse[];
  @ApiProperty({
    type: [String],
    description:
      "Whole-workflow warnings to read BEFORE saving (e.g. a schedule trigger goes live on save).",
  })
  warnings!: string[];
  @ApiProperty({
    type: "object",
    additionalProperties: { type: "number" },
    example: { imported: 4, approximated: 1, unmapped: 0, skipped: 1 },
  })
  counts!: Record<string, number>;
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
  @ApiProperty({ type: String, nullable: true, example: "on-failure-alert" })
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

/** One check a dry run performed against one node (#832). */
export class DryRunCheckResponse {
  @ApiProperty({
    enum: ["config", "request", "credential"],
    example: "credential",
    description:
      "config = catalog validation (pure); request = the built HTTP request (pure); " +
      "credential = a READ-ONLY probe of the connection — the only one that calls the provider.",
  })
  kind!: string;
  @ApiProperty({
    example: false,
    description:
      "False means this check found a problem. A skipped check is never false.",
  })
  ok!: boolean;
  // Optional in the type, so optional in the spec: @ApiProperty would document both of these as
  // required and every generated client would treat a passing check as malformed.
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example:
      "PagerDuty answered 401 to pagerduty.list_incidents — the token was rejected",
    description:
      "Why it failed, or why it was skipped. Never contains a credential.",
  })
  message?: string | null;
  @ApiPropertyOptional({
    example: false,
    description:
      "The check couldn't run — e.g. the provider has no zero-argument read to probe. NOT a failure.",
  })
  skipped?: boolean;
}

/** Every check performed against one node. */
export class DryRunNodeResponse {
  @ApiProperty({ example: "ack" }) nodeId!: string;
  @ApiProperty({ example: "integration" }) type!: string;
  @ApiProperty({ type: [DryRunCheckResponse] })
  checks!: DryRunCheckResponse[];
}

/**
 * The result of dry-running a workflow: does it look runnable, WITHOUT running it (#832).
 * Nothing here executes a node — the only provider traffic is the read-only credential probe.
 */
export class DryRunResponse {
  @ApiProperty({
    example: false,
    description:
      "True when every check passed. A skipped check does not fail the run.",
  })
  ok!: boolean;
  @ApiProperty({
    example: 2,
    description:
      "How many connections were probed. One per DISTINCT connection, not per node — the verdict " +
      "is about the credential, so a flow with six GitHub steps costs one probe.",
  })
  probed!: number;
  @ApiProperty({
    example: 1,
    description:
      "Connections we declined to probe because the provider has no read taking zero required " +
      "fields (GitHub, Slack, Jira and others). Their credentials were NOT verified.",
  })
  unprobeable!: number;
  @ApiProperty({ type: [DryRunNodeResponse] })
  nodes!: DryRunNodeResponse[];
}

/** The result of a workflow-key rename (#904). */
export class RenameWorkflowKeyResponse {
  @ApiProperty({
    example: "support-triage",
    description: "The workflow's key from now on.",
  })
  workflowKey!: string;
  @ApiProperty({
    example: "untitled-workflow",
    description: "The key it had until this call.",
  })
  previousKey!: string;
  @ApiProperty({
    example: ["untitled-workflow"],
    description:
      "Every retired key that still resolves to this workflow — old webhook/sub-workflow/MCP/CLI " +
      "references keep working through these.",
    type: [String],
  })
  aliases!: string[];
}
