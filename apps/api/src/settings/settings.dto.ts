import { IsOptional, IsString, MaxLength } from "class-validator";

export class SaveSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  defaultModel?: string;
}
