import { ApiProperty } from "@nestjs/swagger";

/** One notification channel row — a tenant can have any number per type. */
export class NotificationChannelResponse {
  @ApiProperty({
    example: "9a8b7c6d-…",
    description: "Channel id — the handle for update/delete/test.",
  })
  id!: string;

  @ApiProperty({
    enum: ["slack", "teams", "email"],
    example: "slack",
    description:
      "Channel type — determines the delivery format (Slack blocks / Teams card / SMTP email).",
  })
  type!: "slack" | "teams" | "email";

  @ApiProperty({
    type: String,
    nullable: true,
    example: "#alerts",
    description:
      "User-facing name distinguishing same-type channels. Null = unnamed.",
  })
  label!: string | null;

  @ApiProperty({
    example: true,
    description:
      "Whether this channel sends. Off = skipped even with a URL set.",
  })
  enabled!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "https://hooks.slack.com/services/T000/B000/xxxx",
    description: "Outbound webhook URL for this channel. Null = none set.",
  })
  webhookUrl!: string | null;

  @ApiProperty({
    nullable: true,
    example: null,
    description:
      "Email channels: id of the smtp connection this channel sends through. Null for webhook channels / unconfigured.",
  })
  emailConnectionId!: string | null;

  @ApiProperty({
    type: [String],
    example: [],
    description:
      "Email channels: recipient addresses. Empty for webhook channels.",
  })
  emailTo!: string[];

  @ApiProperty({
    example: true,
    description: "Notify this channel when a run pauses for approval.",
  })
  onApprovalPending!: boolean;

  @ApiProperty({
    example: true,
    description: "Notify this channel when a run fails.",
  })
  onRunFailed!: boolean;

  @ApiProperty({
    example: false,
    description:
      "Notify this channel when monthly spend crosses the budget's alert threshold (once per calendar month). Default off.",
  })
  onBudgetThreshold!: boolean;

  @ApiProperty({
    example: false,
    description:
      "Notify this channel when a workflow is promoted into this environment. Default off.",
  })
  onPromotion!: boolean;
}

/** Result of a successful test send (a failure surfaces as a 400 with a message). */
export class TestNotificationResponse {
  @ApiProperty({ example: true }) ok!: boolean;
  @ApiProperty({
    example: 200,
    description: "HTTP status the webhook returned.",
  })
  status!: number;
}
