import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Put,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import type { AgentGuardrailPolicy } from "@naary/dsl";
import { CurrentPrincipal, type Principal } from "../auth/tenant.decorator";
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
  // a blocklist (a merge could never remove a rule).
  //
  // OWNER/ADMIN ONLY (mirrors tokens/workers/groups). Unlike `displayName`/`defaultModel`, this is
  // a GOVERNANCE control: a `PUT {}` clears the deny-list, the content rules AND redaction in one
  // request, which zeroes all three enforcement points at once (an empty policy short-circuits the
  // activity, makes resolveToolPolicy return nothing, and makes the save gate a no-op). A member
  // who merely holds `edit` on a workflow must not be able to switch off the workspace's controls.

  /** 403 unless the caller is a workspace owner/admin. Same shape as tokens.controller. */
  private assertAdmin(principal?: Principal): void {
    if (principal && principal.role !== "owner" && principal.role !== "admin") {
      throw new ForbiddenException(
        "Only workspace owners or admins can view or change the agent guardrail policy.",
      );
    }
  }

  @ApiEndpoint({
    summary: "Get the workspace agent guardrail policy (owner/admin only)",
    ok: GuardrailPolicyResponse,
  })
  @Get("guardrails")
  getGuardrails(
    @Param("id") tenantId: string,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<AgentGuardrailPolicy> {
    this.assertAdmin(principal);
    return this.guardrails.get(tenantId);
  }

  @ApiEndpoint({
    summary: "Replace the workspace agent guardrail policy (owner/admin only)",
    ok: GuardrailPolicyResponse,
  })
  @Put("guardrails")
  saveGuardrails(
    @Param("id") tenantId: string,
    // Untyped body on purpose: the shape is validated by `agentGuardrailPolicySchema` (zod) in the
    // service, which is the SAME schema the worker and the save gate parse with — a second
    // class-validator DTO would be a drifting duplicate of the security contract.
    @Body() body: unknown,
    @CurrentPrincipal() principal?: Principal,
  ): Promise<AgentGuardrailPolicy> {
    this.assertAdmin(principal);
    return this.guardrails.save(tenantId, body);
  }
}
