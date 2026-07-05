import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

export class SaveNotificationsDto {
  /** Outbound webhook URL (Slack/Teams/generic). Blank/omitted turns it off. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  webhookUrl?: string;

  @IsOptional()
  @IsBoolean()
  onApprovalPending?: boolean;

  @IsOptional()
  @IsBoolean()
  onRunFailed?: boolean;
}
