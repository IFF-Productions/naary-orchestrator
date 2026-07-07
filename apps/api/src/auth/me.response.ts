import { ApiProperty } from "@nestjs/swagger";

/** The authenticated principal (who am I). */
export class MeResponse {
  @ApiProperty({
    example: "tenant_abc123",
    description: "The caller's tenantId.",
  })
  tenantId!: string;

  @ApiProperty({
    required: false,
    example: "user@example.com",
    description: "The authenticated subject (user id / email), if any.",
  })
  subject?: string;
}
