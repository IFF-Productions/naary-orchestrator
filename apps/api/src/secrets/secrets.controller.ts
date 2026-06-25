import { Body, Controller, Param, Post } from "@nestjs/common";
import { CredentialsService, type SaveCredentialResult } from "@naary/secrets";

@Controller("tenants/:id/credentials")
export class SecretsController {
  constructor(private readonly credentials: CredentialsService) {}

  /** Save a tenant's provider key. Validated, encrypted at rest, and NEVER echoed back. */
  @Post()
  save(
    @Param("id") tenantId: string,
    @Body() body: { provider: string; apiKey: string },
  ): Promise<SaveCredentialResult> {
    return this.credentials.saveCredential(
      tenantId,
      body.provider,
      body.apiKey,
    );
  }
}
