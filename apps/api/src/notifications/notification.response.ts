import { ApiProperty } from "@nestjs/swagger";

/** One independently-configurable notification channel for a tenant. */
export class NotificationChannelResponse {
  @ApiProperty({
    enum: ["slack", "teams"],
    example: "slack",
    description:
      "Channel type — determines the payload format + which webhook to use.",
  })
  type!: "slack" | "teams";

  @ApiProperty({
    example: true,
    description:
      "Whether this channel sends. Off = skipped even with a URL set.",
  })
  enabled!: boolean;

  @ApiProperty({
    nullable: true,
    example: "https://hooks.slack.com/services/T000/B000/xxxx",
    description: "Outbound webhook URL for this channel. Null = none set.",
  })
  webhookUrl!: string | null;

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
