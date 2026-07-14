import { ApiProperty } from "@nestjs/swagger";
import type { DashboardItem, PreferenceMode } from "./preferences.service";

/** Per-user preferences (null = unset → client default). */
export class PreferencesResponse {
  @ApiProperty({
    enum: ["builder", "simple"],
    nullable: true,
    example: "simple",
    description: "Experience variant, or null if the user hasn't chosen one.",
  })
  mode!: PreferenceMode | null;

  @ApiProperty({
    type: "array",
    nullable: true,
    description:
      "Customizable Overview layout [{ id, hidden, span }], or null if never customized.",
  })
  dashboard!: DashboardItem[] | null;
}
