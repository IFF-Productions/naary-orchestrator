import { ApiProperty } from "@nestjs/swagger";

/** One per-tenant environment. */
export class EnvironmentResponse {
  @ApiProperty({ example: "b3c1…" }) id!: string;
  @ApiProperty({ example: "Production" }) name!: string;
  @ApiProperty({
    example: "prod",
    description: "Stable slug (X-Environment-Id).",
  })
  slug!: string;
  @ApiProperty({
    example: true,
    description:
      "The default env — holds pre-environments data; can't be deleted.",
  })
  isDefault!: boolean;
}

/** Acknowledgement that an environment was deleted (repo convention: `{ deleted: true }`). */
export class EnvironmentDeletedResponse {
  @ApiProperty({ example: true }) deleted!: boolean;
}
