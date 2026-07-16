import { ApiProperty } from "@nestjs/swagger";

/** One Environment Secret — its NAME only. The value is write-only and NEVER returned. */
export class EnvSecretResponse {
  @ApiProperty({ example: "GITHUB_TOKEN" }) name!: string;
}
