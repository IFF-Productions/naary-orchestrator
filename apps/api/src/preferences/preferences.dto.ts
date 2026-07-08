import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional } from "class-validator";
import type { PreferenceMode } from "./preferences.service";

export class SavePreferencesDto {
  @ApiPropertyOptional({
    enum: ["builder", "simple"],
    nullable: true,
    example: "simple",
    description:
      "Experience variant. Omit or null to clear (fall back to the client default).",
  })
  @IsOptional()
  @IsIn(["builder", "simple"])
  mode?: PreferenceMode | null;
}
