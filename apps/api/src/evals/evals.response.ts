import { ApiProperty } from "@nestjs/swagger";

/** One golden dataset, summarized (the list view — the body itself is a separate GET). */
export class EvalDatasetListResponse {
  @ApiProperty({ example: "b3f1…" }) id!: string;
  @ApiProperty({ example: "refund-triage-golden" }) name!: string;
  @ApiProperty({ example: 20, description: "Number of golden cases." })
  caseCount!: number;
  @ApiProperty({
    example: 2,
    description: "Dataset-level assertions applied to every case.",
  })
  assertionCount!: number;
  @ApiProperty({ example: "2026-07-25T12:00:00.000Z" }) updatedAt!: string;
}

/** One batch eval run. */
export class EvalRunResponse {
  @ApiProperty() id!: string;
  @ApiProperty() datasetId!: string;
  @ApiProperty() datasetName!: string;
  @ApiProperty({
    description:
      "The eval batch's Temporal workflowId (each case is a child run of it).",
  })
  workflowId!: string;
  @ApiProperty({
    example: 7,
    description:
      "The GraphDefinition version this batch measured — pair with contentHash to compare versions on a promote screen.",
  })
  graphVersion!: number;
  @ApiProperty({
    description: "sha256 of the canonical graph this batch measured.",
  })
  graphContentHash!: string;
  @ApiProperty({
    example: "completed",
    description: "running | completed | failed",
  })
  status!: string;
  @ApiProperty({ example: 20 }) totalCases!: number;
  @ApiProperty({ example: 18 }) passed!: number;
  @ApiProperty({ example: 2 }) failed!: number;
  @ApiProperty({
    example: 0,
    description:
      "Cases that could not be judged (the run failed/timed out, or an assertion was unusable) — deliberately NOT counted as failures.",
  })
  errored!: number;
  @ApiProperty({
    nullable: true,
    example: 0.42,
    description: "Summed case cost, including LLM-judge spend.",
  })
  costUsd!: number | null;
  @ApiProperty() startedAt!: string;
  @ApiProperty({ nullable: true }) finishedAt!: string | null;
}

/** One case's verdict. Deliberately carries NO trigger payload, NO run output and NO judge prose. */
export class EvalCaseResultsResponse {
  @ApiProperty() caseName!: string;
  @ApiProperty({
    nullable: true,
    description:
      "The case's child-run workflowId, for drill-down into the normal run view.",
  })
  executionId!: string | null;
  @ApiProperty({ example: "pass", description: "pass | fail | error" })
  verdict!: string;
  @ApiProperty({
    nullable: true,
    example: 1,
    description: "Mean assertion score, 0–1.",
  })
  score!: number | null;
  @ApiProperty({ nullable: true }) costUsd!: number | null;
  @ApiProperty({ nullable: true }) latencyMs!: number | null;
  @ApiProperty({
    type: "array",
    items: { type: "object", additionalProperties: true },
    example: [
      { label: "category", kind: "jsonPathEquals", passed: true, score: 1 },
      { label: "tone", kind: "llmJudge", passed: false, score: 0.4 },
    ],
    description:
      "AssertionOutcome[] — label, kind, passed, 0–1 score, and an optional short error CODE. Never actual/expected values, never the judge's reasoning.",
  })
  assertions!: unknown;
}
