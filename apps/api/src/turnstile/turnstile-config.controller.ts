import { Body, Controller, Delete, Get, HttpCode, Put } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { EnvironmentSel, TenantId } from "../auth/tenant.decorator";
import { EnvironmentsService } from "../environments/environments.service";
import { ApiEndpoint } from "../swagger/api-decorators";
import { TurnstileConfigResponse } from "./turnstile-config.response";
import {
  type TurnstileConfigInput,
  TurnstileConfigService,
} from "./turnstile-config.service";

/**
 * Cloudflare Turnstile bot-protection config for a tenant's public form/chat pages, scoped to the
 * ACTIVE environment (X-Environment-Id → EnvironmentsService). The secret key is WRITE-ONLY: GET
 * returns the public site key + `hasSecret`, never the secret. See
 * docs/design/TURNSTILE-BOT-PROTECTION.md. (The anonymous public verification of a submitted token
 * lives on the form/chat controllers — Slice 2.)
 */
@ApiBearerAuth("bearer")
@Controller("turnstile-config")
export class TurnstileConfigController {
  constructor(
    private readonly service: TurnstileConfigService,
    private readonly environments: EnvironmentsService,
  ) {}

  @ApiEndpoint({
    summary: "Get the Turnstile config (active environment)",
    description:
      "Site key + enabled + hasSecret. The secret is never returned.",
    ok: TurnstileConfigResponse,
  })
  @Get()
  async get(
    @TenantId() tenantId: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<TurnstileConfigResponse | null> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.service.get(tenantId, envId);
  }

  @ApiEndpoint({
    summary: "Set the Turnstile config (active environment)",
    description:
      "Site key required; secret key write-only (omit to keep the existing one).",
    ok: TurnstileConfigResponse,
  })
  @Put()
  async set(
    @TenantId() tenantId: string,
    @Body() body: TurnstileConfigInput,
    @EnvironmentSel() envSel?: string,
  ): Promise<TurnstileConfigResponse> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.service.save(tenantId, envId, body);
  }

  @ApiEndpoint({ summary: "Remove the Turnstile config (active environment)" })
  @Delete()
  @HttpCode(204)
  async remove(
    @TenantId() tenantId: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<void> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    await this.service.remove(tenantId, envId);
  }
}
