import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from "class-validator";

/** Create/replace a workspace's SAML connection (design SAML-SSO.md §"Tenant → IdP mapping"). */
export class UpsertSsoConnectionDto {
  @ApiProperty({
    example: "acme-okta",
    description: "URL-safe slug for /sso/:slug (IdP-initiated entry).",
  })
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{1,62}$/, {
    message: "slug must be lowercase letters, digits and dashes (2-63 chars)",
  })
  slug!: string;

  @ApiPropertyOptional({ example: "Acme Okta", description: "Display label." })
  @IsOptional()
  @IsString()
  label?: string;

  @ApiProperty({
    example: "http://www.okta.com/exk1a2b3c4",
    description:
      "The IdP's SAML entity id — the assertion <Issuer>. Unique across the instance: it is how an unauthenticated ACS POST maps to this workspace.",
  })
  @IsString()
  @IsNotEmpty()
  idpEntityId!: string;

  @ApiProperty({
    example: "https://acme.okta.com/app/acme_naary/exk1a2b3c4/sso/saml",
    description: "The IdP's SSO (login) URL.",
  })
  @IsString()
  @Matches(/^https:\/\//, { message: "idpSsoUrl must be an https URL" })
  idpSsoUrl!: string;

  @ApiProperty({
    description:
      "The IdP's SIGNING CERTIFICATE (PEM, or the bare base64 from its metadata <X509Certificate>). Public key material only.",
  })
  @IsString()
  @IsNotEmpty()
  idpCertPem!: string;

  @ApiProperty({
    example: ["acme.com"],
    description:
      "Email domains this IdP may assert. REQUIRED and non-empty — an empty list would let this IdP assert any address, which is exactly the cross-tenant linking hole.",
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  allowedEmailDomains!: string[];

  @ApiPropertyOptional({
    example: "member",
    description:
      "Role granted when auto-provisioning. Never read from the assertion.",
  })
  @IsOptional()
  @IsIn(["owner", "admin", "member"])
  defaultRole?: string;

  @ApiPropertyOptional({
    description: "Create a Membership on first login (JIT). Default true.",
  })
  @IsOptional()
  @IsBoolean()
  autoProvision?: boolean;

  @ApiPropertyOptional({ description: "Kill switch. Default true." })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
