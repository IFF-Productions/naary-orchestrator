import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Validate,
  type ValidationArguments,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from "class-validator";
import type { CreateConnectionInput } from "@naary/connections";

// Types whose serverUrl is a NON-SECRET display label (host / name), not an https
// URL — the real secret (DSN / signing key) rides in `token`.
const NON_URL_TYPES = [
  "postgres",
  "mssql",
  "mysql",
  "signing",
  "smtp",
  "firestore",
];

/**
 * serverUrl is validated by connection kind:
 *  - MCP/HTTP connections: an https URL (https-only closes the trivial http://
 *    internal-target SSRF vector; the full egress block is the separate Sec#2 item).
 *  - DB connections (postgres/mssql/mysql/firestore): a NON-SECRET display host — the real DSN (with
 *    password) rides in `token` — so only a non-empty string is required.
 */
@ValidatorConstraint({ name: "connectionServerUrl", async: false })
class ConnectionServerUrlConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (typeof value !== "string" || value.length === 0) return false;
    const type = (args.object as { type?: string }).type;
    if (type && NON_URL_TYPES.includes(type)) return true;
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }
  defaultMessage(): string {
    return "serverUrl must be an https URL (or a non-empty host for database connections)";
  }
}

export class CreateConnectionDto implements CreateConnectionInput {
  @ApiProperty({
    enum: [
      "atlassian",
      "github",
      "custom",
      "postgres",
      "mssql",
      "mysql",
      "firestore",
      "signing",
      "smtp",
    ],
    example: "github",
    description: "Connection kind.",
  })
  @IsIn([
    "atlassian",
    "github",
    "custom",
    "postgres",
    "mssql",
    "mysql",
    "firestore",
    "signing",
    "smtp",
  ])
  type!: CreateConnectionInput["type"];

  @ApiProperty({
    example: "Prod GitHub",
    description: "Display label for the connection.",
  })
  @IsString()
  @IsNotEmpty()
  label!: string;

  @ApiProperty({
    example: "https://api.github.com",
    description:
      "https URL for MCP/HTTP connections, or a non-secret display host for DB connections (the DSN rides in `token`).",
  })
  @Validate(ConnectionServerUrlConstraint)
  serverUrl!: string;

  @ApiProperty({
    enum: ["api_token", "pat", "oauth", "connection_string"],
    example: "pat",
    description: "How the connection authenticates.",
  })
  @IsIn(["api_token", "pat", "oauth", "connection_string"])
  authMode!: CreateConnectionInput["authMode"];

  @ApiPropertyOptional({
    type: [String],
    example: ["repo", "read:org"],
    description: "Requested OAuth/token scopes.",
  })
  @IsOptional()
  @IsString({ each: true })
  scopes?: string[];

  @ApiPropertyOptional({
    example: "ghp_xxx",
    description:
      "Secret credential (PAT / api_token / connection string). Stored encrypted, never returned.",
  })
  @IsOptional()
  @IsString()
  token?: string;
}
