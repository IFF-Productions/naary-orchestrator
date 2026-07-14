import { ApiProperty } from "@nestjs/swagger";

/** Per-tenant notification settings (webhook + which events fire it). */
export class NotificationSettingsResponse {
  @ApiProperty({
    nullable: true,
    example: "https://hooks.slack.com/services/T000/B000/xxxx",
    description: "Outbound webhook URL. Null = notifications off.",
  })
  webhookUrl!: string | null;

  @ApiProperty({
    enum: ["slack", "teams"],
    example: "slack",
    description: "Payload format posted to the webhook.",
  })
  channel!: "slack" | "teams";

  @ApiProperty({
    example: true,
    description: "Notify when a run pauses for approval.",
  })
  onApprovalPending!: boolean;

  @ApiProperty({ example: true, description: "Notify when a run fails." })
  onRunFailed!: boolean;
}
