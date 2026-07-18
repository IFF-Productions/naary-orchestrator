import { ApiProperty } from "@nestjs/swagger";
import { IsString } from "class-validator";

/**
 * Public v1 request bodies for the config surface. v1-OWNED so the public contract can't drift when
 * the internal Variables/EnvSecrets services change. The key/name is always the path param (never the
 * body); tenantId + environment come from the token (+ optional X-Environment-Id).
 */

/** Body for `PUT /v1/config/variables/:key` — the value to store for `{{ $vars.KEY }}`. */
export class SetVariableDto {
  @ApiProperty({
    example: "https://api.example.com",
    description: "The variable's value (a plain string).",
  })
  @IsString()
  value!: string;
}

/**
 * Body for `PUT /v1/config/secrets/:name` — the secret value to store for `{{ $secrets.NAME }}`.
 * WRITE-ONLY: the value is encrypted at rest and NEVER returned by any endpoint (CLAUDE.md Tier-1 §4).
 */
export class SetSecretDto {
  @ApiProperty({
    example: "sk-live-...",
    description:
      "The secret's value (a non-empty string). Encrypted at rest; never returned or logged.",
  })
  @IsString()
  value!: string;
}
