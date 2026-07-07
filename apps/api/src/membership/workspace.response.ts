import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/** One workspace the caller belongs to (powers the workspace switcher). */
export class WorkspaceViewResponse {
  @ApiProperty({ example: "tenant_123" }) tenantId!: string;
  @ApiProperty({
    example: "owner",
    enum: ["owner", "admin", "member"],
    description: "The caller's role in this workspace.",
  })
  role!: string;
  @ApiPropertyOptional({
    example: "Acme Corp",
    description:
      "The workspace's display name (TenantSettings.displayName), if set.",
  })
  name?: string;
}
