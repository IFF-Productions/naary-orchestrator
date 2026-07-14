import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsArray, IsIn, IsOptional } from "class-validator";
import type { DashboardItem, PreferenceMode } from "./preferences.service";

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

  /** Customizable Overview layout. Omit to leave unchanged; null clears to the default.
   *  Shape is sanitized server-side (id/hidden/span), so a loose array check suffices. */
  @ApiPropertyOptional({
    type: "array",
    nullable: true,
    description:
      "Ordered widget layout for the Overview: [{ id, hidden, span }]. Omit to leave unchanged.",
  })
  @IsOptional()
  @IsArray()
  dashboard?: DashboardItem[] | null;
}
