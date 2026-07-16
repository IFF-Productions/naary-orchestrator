import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { EnvironmentSel, TenantId } from "../auth/tenant.decorator";
import { EnvironmentsService } from "../environments/environments.service";
import { ApiEndpoint } from "../swagger/api-decorators";
import { EnvSecretResponse } from "./env-secret.response";
import { EnvSecretsService } from "./env-secrets.service";

/**
 * Environment Secrets ($secrets) — user-named SECRET values, scoped to the ACTIVE environment
 * (X-Environment-Id → EnvironmentsService), referenced in node config as `{{ $secrets.NAME }}`.
 * WRITE-ONLY: GET yields NAMES only; the value is set/replaced but never read back (the worker
 * resolves + decrypts it in-activity; it never enters the API response, graph, ctx, or history —
 * CLAUDE.md Tier-1 §4). Distinct from `tenants/:id/credentials` (BYOK model-provider keys).
 */
@ApiBearerAuth("bearer")
@Controller("env-secrets")
export class EnvSecretsController {
  constructor(
    private readonly secrets: EnvSecretsService,
    private readonly environments: EnvironmentsService,
  ) {}

  @ApiEndpoint({
    summary: "List secret names (active environment)",
    description: "Names only — the value is write-only and never returned.",
    ok: [EnvSecretResponse],
  })
  @Get()
  async list(
    @TenantId() tenantId: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<EnvSecretResponse[]> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    const names = await this.secrets.list(tenantId, envId);
    return names.map((name) => ({ name }));
  }

  @ApiEndpoint({ summary: "Set a secret value (active environment)" })
  @Put(":name")
  @HttpCode(204)
  async set(
    @TenantId() tenantId: string,
    @Param("name") name: string,
    @Body() body: { value?: unknown },
    @EnvironmentSel() envSel?: string,
  ): Promise<void> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    await this.secrets.set(tenantId, envId, name, body?.value);
  }

  @ApiEndpoint({ summary: "Delete a secret (active environment)" })
  @Delete(":name")
  @HttpCode(204)
  async remove(
    @TenantId() tenantId: string,
    @Param("name") name: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<void> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    await this.secrets.remove(tenantId, envId, name);
  }
}
