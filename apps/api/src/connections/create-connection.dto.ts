import { IsIn, IsNotEmpty, IsOptional, IsString, IsUrl } from "class-validator";
import type { CreateConnectionInput } from "@naary/connections";

export class CreateConnectionDto implements CreateConnectionInput {
  @IsIn(["atlassian", "github", "custom"])
  type!: CreateConnectionInput["type"];

  @IsString()
  @IsNotEmpty()
  label!: string;

  // https-only closes the most trivial SSRF vector (http:// internal targets);
  // a full egress allowlist / private-IP block is the separate Sec#2 item.
  @IsUrl({ protocols: ["https"], require_protocol: true })
  serverUrl!: string;

  @IsIn(["api_token", "pat", "oauth"])
  authMode!: CreateConnectionInput["authMode"];

  @IsOptional()
  @IsString({ each: true })
  scopes?: string[];

  @IsOptional()
  @IsString()
  token?: string;
}
