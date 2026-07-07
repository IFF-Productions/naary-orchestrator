import { ApiProperty } from "@nestjs/swagger";

/** Per-tenant settings (null fields = unset). */
export class SettingsResponse {
  @ApiProperty({
    nullable: true,
    example: "Acme Inc.",
    description: "Tenant display name.",
  })
  displayName!: string | null;

  @ApiProperty({
    nullable: true,
    example: "claude-sonnet-4",
    description: "Default model for new agent nodes.",
  })
  defaultModel!: string | null;
}
