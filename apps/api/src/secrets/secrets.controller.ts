import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { CredentialsService, type SaveCredentialResult } from "@naary/secrets";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SaveCredentialDto } from "./save-credential.dto";

@Controller("tenants/:id/credentials")
@UseGuards(RolesGuard)
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
   *  The path `:id` is guaranteed (by AuthGuard) to equal the authenticated tenant.
   *  Admin+ (design §5 — provider keys are sensitive). */
  @Post()
  @Roles("admin")
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
