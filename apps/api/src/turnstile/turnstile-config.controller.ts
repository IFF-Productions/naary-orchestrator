import { Body, Controller, Delete, Get, HttpCode, Put } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { EnvironmentSel, TenantId } from "../auth/tenant.decorator";
import { EmbedOriginsService } from "../common/embed-origins.service";
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
 * lives on the form/chat controllers — Slice 2.) `allowedHostnames` is the SHARED domain allowlist:
 * it gates Turnstile solved hostnames AND the public embed CORS layer (#617), so a write here
 * invalidates the embed-origin resolver's cache.
 */
@ApiBearerAuth("bearer")
@Controller("turnstile-config")
export class TurnstileConfigController {
  constructor(
    private readonly service: TurnstileConfigService,
    private readonly environments: EnvironmentsService,
    // The shared domain allowlist also drives public embed CORS (#617); drop its memoized copy on
    // every write so an edit applies immediately rather than after the resolver's TTL.
    private readonly embedOrigins: EmbedOriginsService,
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
    const saved = await this.service.save(tenantId, envId, body);
    this.embedOrigins.invalidate();
    return saved;
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
    this.embedOrigins.invalidate();
  }
}
