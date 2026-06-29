import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { CredentialsService, type SaveCredentialResult } from "@naary/secrets";
import { SaveCredentialDto } from "./save-credential.dto";

@Controller("tenants/:id/credentials")
export class SecretsController {
  constructor(private readonly credentials: CredentialsService) {}

  /** Which providers have a saved key (names + validity only — never the key). */
  @Get()
  list(
    @Param("id") tenantId: string,
  ): Promise<{ provider: string; isValid: boolean }[]> {
    return this.credentials.listProviders(tenantId);
  }

  /** Save a tenant's provider key. Validated, encrypted at rest, and NEVER echoed back.
   *  The path `:id` is guaranteed (by AuthGuard) to equal the authenticated tenant. */
  @Post()
  save(
    @Param("id") tenantId: string,
    @Body() body: SaveCredentialDto,
  ): Promise<SaveCredentialResult> {
    return this.credentials.saveCredential(
      tenantId,
      body.provider,
      body.apiKey,
    );
  }
}
