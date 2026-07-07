import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

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
