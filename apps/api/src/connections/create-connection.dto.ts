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
const NON_URL_TYPES = ["postgres", "mssql", "signing", "smtp"];

/**
 * serverUrl is validated by connection kind:
 *  - MCP/HTTP connections: an https URL (https-only closes the trivial http://
 *    internal-target SSRF vector; the full egress block is the separate Sec#2 item).
 *  - DB connections (postgres/mssql): a NON-SECRET display host — the real DSN (with
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
  @IsIn([
    "atlassian",
    "github",
    "custom",
    "postgres",
    "mssql",
    "signing",
    "smtp",
  ])
  type!: CreateConnectionInput["type"];

  @IsString()
  @IsNotEmpty()
  label!: string;

  @Validate(ConnectionServerUrlConstraint)
  serverUrl!: string;

  @IsIn(["api_token", "pat", "oauth", "connection_string"])
  authMode!: CreateConnectionInput["authMode"];

  @IsOptional()
  @IsString({ each: true })
  scopes?: string[];

  @IsOptional()
  @IsString()
  token?: string;
}
