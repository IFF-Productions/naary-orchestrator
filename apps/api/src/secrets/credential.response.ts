import { ApiProperty } from "@nestjs/swagger";

/** Which providers have a saved key (name + validity only — never the key). */
export class CredentialProviderResponse {
  @ApiProperty({ example: "anthropic" }) provider!: string;
  @ApiProperty({
    example: true,
    description: "Whether the stored key last validated successfully.",
  })
  isValid!: boolean;
}

/** Result of saving a provider key — metadata only, never the key. */
export class SaveCredentialResponse {
  @ApiProperty({ example: "cred_8f3a1c2e" }) id!: string;
  @ApiProperty({ example: "anthropic" }) provider!: string;
  @ApiProperty({ example: true }) isValid!: boolean;
}
