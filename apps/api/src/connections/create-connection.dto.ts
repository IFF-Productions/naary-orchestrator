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

// Types whose serverUrl is a NON-SECRET display label (a host, or just a name), never an
// address this server dials — the real endpoint AND its credential ride together in `token`
// (a DSN, an SMTP URI, a key). Deliberately a principle rather than a category: it is NOT
// "the databases" — `signing` keys have no host at all, and `smtp` is not a database.
const NON_URL_TYPES = [
  "postgres",
  "mssql",
  "mysql",
  "signing",
  "smtp",
  "firestore",
  "kafka",
  "mqtt",
];

/**
 * serverUrl is validated by what this server DOES with it, which is the only rule that
 * stays true as types are added:
 *  - When it is the address we dial (MCP/HTTP connections): an https URL (https-only
 *    closes the trivial http:// internal-target SSRF vector; the full egress block is
 *    the separate Sec#2 item).
 *  - When it is only a display label — see NON_URL_TYPES, where the real endpoint and
 *    credential ride together in `token` — any non-empty string, since nothing dials it.
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
    return (
      "serverUrl must be an https URL for connection types this server calls over HTTP. " +
      "For types whose serverUrl is only a display label — the real endpoint and its " +
      "credential ride in `token` — any non-empty value is accepted."
    );
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
      "kafka",
      "mqtt",
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
    "kafka",
    "mqtt",
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
      "An https URL when this server calls the connection over HTTP (MCP/app servers). When it is " +
      "only a non-secret display label, because the real endpoint and its credential ride together " +
      "in `token` (e.g. a SQL DSN, an SMTP URI, a signing key), any non-empty value.",
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
