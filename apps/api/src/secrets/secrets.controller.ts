import { Body, Controller, Param, Post } from "@nestjs/common";
import { CredentialsService, type SaveCredentialResult } from "@naary/secrets";
import { SaveCredentialDto } from "./save-credential.dto";

@Controller("tenants/:id/credentials")
export class SecretsController {
  constructor(private readonly credentials: CredentialsService) {}

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
