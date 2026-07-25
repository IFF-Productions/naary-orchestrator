import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import type { AgentGuardrailPolicy } from "@naary/dsl";
import { ApiEndpoint } from "../swagger/api-decorators";
import { GuardrailsService } from "./guardrails.service";
import { SaveSettingsDto } from "./settings.dto";
import { GuardrailPolicyResponse, SettingsResponse } from "./settings.response";
import { type SettingsView, SettingsService } from "./settings.service";

/** tenantId from the path; AuthGuard enforces path-tenant == token-tenant. */
@ApiBearerAuth("bearer")
@Controller("tenants/:id/settings")
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly guardrails: GuardrailsService,
  ) {}

  @ApiEndpoint({ summary: "Get tenant settings", ok: SettingsResponse })
  @Get()
  get(@Param("id") tenantId: string): Promise<SettingsView> {
    return this.settings.get(tenantId);
  }

  @ApiEndpoint({ summary: "Update tenant settings", ok: SettingsResponse })
  @Put()
  save(
    @Param("id") tenantId: string,
    @Body() body: SaveSettingsDto,
  ): Promise<SettingsView> {
    return this.settings.save(tenantId, body);
  }

  // --- Agent guardrails (#576) ---------------------------------------------------------------
  // Its own sub-resource rather than fields on SaveSettingsDto: the policy is a nested object
  // that zod (not class-validator) validates, and a whole-object PUT is the right semantics for
  // a blocklist (a merge could never remove a rule). Both routes are workspace-admin surface —
  // the global AuthGuard already pins path-tenant == token-tenant, which is the same
  // authorization the sibling settings routes rely on.

  @ApiEndpoint({
    summary: "Get the workspace agent guardrail policy",
    ok: GuardrailPolicyResponse,
  })
  @Get("guardrails")
  getGuardrails(@Param("id") tenantId: string): Promise<AgentGuardrailPolicy> {
    return this.guardrails.get(tenantId);
  }

  @ApiEndpoint({
    summary: "Replace the workspace agent guardrail policy",
    ok: GuardrailPolicyResponse,
  })
  @Put("guardrails")
  saveGuardrails(
    @Param("id") tenantId: string,
    // Untyped body on purpose: the shape is validated by `agentGuardrailPolicySchema` (zod) in the
    // service, which is the SAME schema the worker and the save gate parse with — a second
    // class-validator DTO would be a drifting duplicate of the security contract.
    @Body() body: unknown,
  ): Promise<AgentGuardrailPolicy> {
    return this.guardrails.save(tenantId, body);
  }
}
