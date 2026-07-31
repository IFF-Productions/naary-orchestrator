/** Swagger shapes for the self-healing endpoints (Phase 2). */
import { ApiProperty } from "@nestjs/swagger";

export class SelfHealSettingResponse {
  @ApiProperty({
    example: false,
    description:
      "Whether a failed run of this workflow proposes a fix. Default OFF — an automatic " +
      "edit to a production workflow is opt-in per workflow, per environment.",
  })
  enabled!: boolean;
}

/** How much a proposal changes — enough for a list row without diffing every graph. */
export class FixDiffSummary {
  @ApiProperty({ example: 1 }) add!: number;
  @ApiProperty({ example: 1 }) chg!: number;
  @ApiProperty({ example: 0 }) del!: number;
  @ApiProperty({ example: 2 }) total!: number;
}

export class FixProposalResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ example: "pagerduty-incident-triage" }) workflowKey!: string;
  @ApiProperty({
    example: "exec-t-demo-ce20c38b",
    description: "The failed run this fix was proposed for.",
  })
  runId!: string;
  @ApiProperty({
    example: "pagerduty: Missing required header 'From'",
    description:
      "The failing step and its error. Never node OUTPUT content — that is not stored here.",
  })
  failureSummary!: string;
  @ApiProperty({
    example: 7,
    description:
      "The version this fix was written against. Approving refuses if the workflow has moved on.",
  })
  baseVersion!: number;
  @ApiProperty({ type: FixDiffSummary }) diffSummary!: FixDiffSummary;
  @ApiProperty({
    example: "pending",
    description: "pending | approved | rejected | applied | stale | expired",
  })
  status!: string;
  @ApiProperty({ type: Number, nullable: true, example: 8 })
  appliedVersion!: number | null;
  @ApiProperty({ example: "2026-07-30T14:33:02.511Z" }) createdAt!: string;
}

export class FixProposalDetailResponse extends FixProposalResponse {
  @ApiProperty({
    type: Object,
    description:
      "The graph this fix proposes, exactly as approving would save it — so a reviewer can diff " +
      "it against the current version before deciding.",
  })
  proposedGraph!: Record<string, unknown>;
}
