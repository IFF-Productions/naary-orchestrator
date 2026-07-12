import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";

/** Body for starting a GitHub App install — only a display label (the grant comes from GitHub). */
export class GithubAppInstallStartDto {
  @ApiPropertyOptional({
    example: "Prod GitHub",
    description:
      "Display label for the connection the callback will create. Defaults to 'GitHub'.",
  })
  @IsOptional()
  @IsString()
  label?: string;
}
