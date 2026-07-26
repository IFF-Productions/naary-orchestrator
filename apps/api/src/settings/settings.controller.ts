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

  /**
   * 403 unless the caller is a workspace owner/admin. FAILS CLOSED on a missing principal:
   * `if (principal && …)` skipped the check entirely whenever `@CurrentPrincipal()` didn't
   * resolve, which on an authz gate for the workspace's agent controls is the wrong default —
   * a wiring change elsewhere would have quietly opened it. tokens.controller and
   * workers.controller both take a NON-optional principal for the same reason. An internal,
   * actor-less caller should use `GuardrailsService` directly rather than this HTTP route.
   */
  private assertAdmin(principal: Principal): void {
    if (!principal) {
      throw new ForbiddenException(
        "Changing the agent guardrail policy requires a signed-in owner or admin.",
      );
    }
    if (principal.role !== "owner" && principal.role !== "admin") {
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
  async getGuardrails(
    @Param("id") tenantId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ policy: AgentGuardrailPolicy }> {
    this.assertAdmin(principal);
    // ENVELOPED to match GuardrailPolicyResponse, which models `{ policy: <object> }`. Returning
    // the bare policy made the OpenAPI contract wrong for every generated client, and an envelope
    // also leaves room to report derived facts (e.g. "empty") later without a breaking change.
    return { policy: await this.guardrails.get(tenantId) };
  }

  @ApiEndpoint({
    summary: "Replace the workspace agent guardrail policy (owner/admin only)",
    ok: GuardrailPolicyResponse,
  })
  @Put("guardrails")
  async saveGuardrails(
    @Param("id") tenantId: string,
    // Untyped body on purpose: the shape is validated by `agentGuardrailPolicySchema` (zod) in the
    // service, which is the SAME schema the worker and the save gate parse with — a second
    // class-validator DTO would be a drifting duplicate of the security contract.
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ policy: AgentGuardrailPolicy }> {
    this.assertAdmin(principal);
    // Same envelope as the GET, so a client can round-trip one shape.
    return { policy: await this.guardrails.save(tenantId, body) };
  }
}
