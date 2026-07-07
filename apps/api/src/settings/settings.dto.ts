import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

export class SaveSettingsDto {
  @ApiPropertyOptional({
    maxLength: 120,
    example: "Acme Inc.",
    description: "Tenant display name.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @ApiPropertyOptional({
    maxLength: 120,
    example: "claude-sonnet-4",
    description: "Default model for new agent nodes.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  defaultModel?: string;
}
