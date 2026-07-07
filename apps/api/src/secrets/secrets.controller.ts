import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { CredentialsService, type SaveCredentialResult } from "@naary/secrets";
import { ApiEndpoint } from "../swagger/api-decorators";
import {
  CredentialProviderResponse,
  SaveCredentialResponse,
} from "./credential.response";
import { SaveCredentialDto } from "./save-credential.dto";

@ApiBearerAuth("bearer")
@Controller("tenants/:id/credentials")
export class SecretsController {
  constructor(private readonly credentials: CredentialsService) {}

  /** Which providers have a saved key (names + validity only — never the key). */
  @ApiEndpoint({
    summary: "List configured providers",
    description: "Provider names + validity only — never the key.",
    ok: [CredentialProviderResponse],
  })
  @Get()
  list(
    @Param("id") tenantId: string,
  ): Promise<{ provider: string; isValid: boolean }[]> {
    return this.credentials.listProviders(tenantId);
  }

  /** Save a tenant's provider key. Validated, encrypted at rest, and NEVER echoed back.
   *  The path `:id` is guaranteed (by AuthGuard) to equal the authenticated tenant. */
  @ApiEndpoint({
    summary: "Save a provider key",
    description:
      "Validated, encrypted at rest, and never echoed back (metadata only).",
    created: SaveCredentialResponse,
  })
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
