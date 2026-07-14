import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

export class SaveNotificationsDto {
  /** Outbound webhook URL (Slack/Teams/generic). Blank/omitted turns it off. */
  @ApiPropertyOptional({
    maxLength: 2000,
    example: "https://hooks.slack.com/services/T000/B000/xxxx",
    description:
      "Outbound webhook URL (Slack/Teams/generic). Blank/omitted turns notifications off.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  webhookUrl?: string;

  /** Payload format for the webhook: "slack" (Block Kit) or "teams" (Adaptive Card). */
  @ApiPropertyOptional({
    enum: ["slack", "teams"],
    example: "slack",
    description:
      "Payload format posted to the webhook. 'teams' expects a Microsoft Teams Workflows webhook URL.",
  })
  @IsOptional()
  @IsIn(["slack", "teams"])
  channel?: "slack" | "teams";

  @ApiPropertyOptional({
    example: true,
    description: "Notify when a run pauses for approval.",
  })
  @IsOptional()
  @IsBoolean()
  onApprovalPending?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: "Notify when a run fails.",
  })
  @IsOptional()
  @IsBoolean()
  onRunFailed?: boolean;
}
