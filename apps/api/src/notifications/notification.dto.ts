import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

/** Patch for ONE notification channel (the channel type comes from the route). Every field is
 *  optional so the UI can toggle `enabled` alone, set only the URL, etc. */
export class SaveNotificationChannelDto {
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
}
