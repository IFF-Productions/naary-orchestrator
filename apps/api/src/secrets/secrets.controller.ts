import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { CredentialsService, type SaveCredentialResult } from "@naary/secrets";
import { EnvironmentSel } from "../auth/tenant.decorator";
import { EnvironmentsService } from "../environments/environments.service";
import { ApiEndpoint } from "../swagger/api-decorators";
import {
  CredentialProviderResponse,
  SaveCredentialResponse,
} from "./credential.response";
import { SaveCredentialDto } from "./save-credential.dto";

@ApiBearerAuth("bearer")
@Controller("tenants/:id/credentials")
export class SecretsController {
  constructor(
    private readonly credentials: CredentialsService,
    private readonly environments: EnvironmentsService,
  ) {}

  /** Which providers have a saved key IN THIS ENV (names + validity only — never the key).
   *  Env-scoped (Slice 5): sandbox and prod hold separate keys. */
  @ApiEndpoint({
    summary: "List configured providers",
    description: "Provider names + validity only — never the key.",
    ok: [CredentialProviderResponse],
  })
  @Get()
  async list(
    @Param("id") tenantId: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<{ provider: string; isValid: boolean }[]> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.credentials.listProviders(tenantId, envId);
  }

  /** Save a tenant's provider key IN THE ACTIVE ENV. Validated, encrypted at rest, and NEVER
   *  echoed back. The path `:id` is guaranteed (by AuthGuard) to equal the authenticated tenant. */
  @ApiEndpoint({
    summary: "Save a provider key",
    description:
      "Validated, encrypted at rest, and never echoed back (metadata only).",
    created: SaveCredentialResponse,
  })
  @Post()
  async save(
    @Param("id") tenantId: string,
    @Body() body: SaveCredentialDto,
    @EnvironmentSel() envSel?: string,
  ): Promise<SaveCredentialResult> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.credentials.saveCredential(
      tenantId,
      envId,
      body.provider,
      body.apiKey,
    );
  }
}
