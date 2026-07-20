import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import {
  MAX_EMAIL_RECIPIENTS,
  NOTIFICATION_CHANNEL_TYPES,
} from "./notifications.service";

/** Patch for ONE notification channel (addressed by :channelId in the route). Every field is
 *  optional so the UI can toggle `enabled` alone, set only the URL, etc. */
export class UpdateNotificationChannelDto {
  @ApiPropertyOptional({
    maxLength: 100,
    example: "#alerts",
    description:
      "User-facing name distinguishing same-type channels. Blank clears it.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;

  @ApiPropertyOptional({
    example: true,
    description:
      "Whether this channel sends. Off = the worker skips it even with a URL set.",
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    maxLength: 2000,
    example: "https://hooks.slack.com/services/T000/B000/xxxx",
    description:
      "Outbound webhook URL for this channel. Blank clears it (nothing to POST to).",
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  webhookUrl?: string;

  @ApiPropertyOptional({
    nullable: true,
    example: "conn-9a8b7c6d",
    description:
      "Email channels: id of the smtp connection to send through (the same connection the Send Email node uses; credentials stay in the encrypted store). Null clears it.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  emailConnectionId?: string;

  @ApiPropertyOptional({
    type: [String],
    maxItems: MAX_EMAIL_RECIPIENTS,
    example: ["ops@acme.io"],
    description: `Email channels: recipient addresses (max ${MAX_EMAIL_RECIPIENTS}). Replaces the saved list.`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_EMAIL_RECIPIENTS)
  @IsString({ each: true })
  @MaxLength(320, { each: true })
  emailTo?: string[];

  @ApiPropertyOptional({
    example: true,
    description: "Notify this channel when a run pauses for approval.",
  })
  @IsOptional()
  @IsBoolean()
  onApprovalPending?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: "Notify this channel when a run fails.",
  })
  @IsOptional()
  @IsBoolean()
  onRunFailed?: boolean;

  @ApiPropertyOptional({
    example: false,
    description:
      "Notify this channel when monthly spend crosses the budget's alert threshold (at most once per calendar month). Default off.",
  })
  @IsOptional()
  @IsBoolean()
  onBudgetThreshold?: boolean;

  @ApiPropertyOptional({
    example: false,
    description:
      "Notify this channel when a workflow is promoted into this environment. Default off.",
  })
  @IsOptional()
  @IsBoolean()
  onPromotion?: boolean;
}

/** Create a new channel. Same patch fields plus the REQUIRED type — a tenant can hold any
 *  number of channels per type (each row is its own webhook). */
export class CreateNotificationChannelDto extends UpdateNotificationChannelDto {
  @ApiProperty({
    enum: NOTIFICATION_CHANNEL_TYPES,
    example: "slack",
    description: "Channel type — determines the payload format.",
  })
  @IsString()
  @IsIn(NOTIFICATION_CHANNEL_TYPES as unknown as string[])
  type!: string;
}
