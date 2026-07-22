import { ApiProperty } from "@nestjs/swagger";

/** One conversation turn within a builder session (user prompt or assistant change-summary). */
export class BuilderTurnResponse {
  @ApiProperty({ example: "c0ffee00-0000-0000-0000-000000000000" })
  id!: string;
  @ApiProperty({ enum: ["user", "assistant"], example: "user" })
  role!: string;
  @ApiProperty({
    example: "Add a Slack notification after the approval step.",
    description:
      "The user's prompt, or a short assistant summary of the change it made.",
  })
  content!: string;
  @ApiProperty({
    required: false,
    nullable: true,
    type: Number,
    example: 0.0123,
    description:
      "Metered cost of an assistant turn (BYOK); null for user turns.",
  })
  costUsd?: number | null;
  @ApiProperty({
    required: false,
    type: [String],
    example: [
      "Add an approval step",
      "Add error handling",
      "Looks good — save it",
    ],
    description:
      "Tappable quick-reply suggestions the builder offers after an assistant turn; " +
      "selecting one becomes the next user message. Empty on user turns.",
  })
  options?: string[];
  @ApiProperty({ format: "date-time", example: "2026-08-02T14:00:00.000Z" })
  createdAt!: string;
}

/** A full builder session, including its working draft and conversation. Returned by
 *  open / get / close. */
export class BuilderSessionResponse {
  @ApiProperty({ example: "5f1e0000-0000-0000-0000-000000000000" })
  id!: string;
  @ApiProperty({ enum: ["open", "closed"], example: "open" })
  status!: string;
  @ApiProperty({
    required: false,
    nullable: true,
    enum: ["saved", "done", "abandoned"],
    description: "Why the session closed; null while open.",
  })
  closedReason?: string | null;
  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    example: "onboarding-flow",
    description:
      "The workflow this session seeds from / saves to, when applicable.",
  })
  workflowKey?: string | null;
  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    description: "The environment the build targets.",
  })
  environmentId?: string | null;
  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    example: "Slack approval flow",
    description: "Short label for the resume list.",
  })
  title?: string | null;
  @ApiProperty({
    required: false,
    nullable: true,
    type: Object,
    additionalProperties: true,
    description:
      "The latest validated working draft (graph JSON), or null before the first turn.",
  })
  currentGraph?: unknown;
  @ApiProperty({ type: [BuilderTurnResponse] })
  turns!: BuilderTurnResponse[];
  @ApiProperty({ format: "date-time", example: "2026-08-02T14:00:00.000Z" })
  createdAt!: string;
  @ApiProperty({ format: "date-time", example: "2026-08-02T14:05:00.000Z" })
  updatedAt!: string;
  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    format: "date-time",
  })
  closedAt?: string | null;
}

/** A lightweight session for the resume list — no graph body or turns. */
export class BuilderSessionSummaryResponse {
  @ApiProperty({ example: "5f1e0000-0000-0000-0000-000000000000" })
  id!: string;
  @ApiProperty({ enum: ["open", "closed"], example: "open" })
  status!: string;
  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    example: "onboarding-flow",
  })
  workflowKey?: string | null;
  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    example: "Slack approval flow",
  })
  title?: string | null;
  @ApiProperty({ format: "date-time", example: "2026-08-02T14:05:00.000Z" })
  updatedAt!: string;
}
