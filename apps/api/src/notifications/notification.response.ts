import { ApiProperty } from "@nestjs/swagger";

/** One notification channel row — a tenant can have any number per type. */
export class NotificationChannelResponse {
  @ApiProperty({
    example: "9a8b7c6d-…",
    description: "Channel id — the handle for update/delete/test.",
  })
  id!: string;

  @ApiProperty({
    enum: ["slack", "teams"],
    example: "slack",
    description:
      "Channel type — determines the payload format + which webhook to use.",
  })
  type!: "slack" | "teams";

  @ApiProperty({
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
