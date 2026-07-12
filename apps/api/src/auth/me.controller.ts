import { Controller, Get } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { getAllFlags } from "@naary/flags";
import { ApiEndpoint } from "../swagger/api-decorators";
import { MeFlagsResponse, MeResponse } from "./me.response";
import { CurrentPrincipal, type Principal } from "./tenant.decorator";
import { UserScoped } from "./user-scoped.decorator";

/**
 * "Who am I": returns the authenticated principal so the SPA knows its own
 * tenantId (for tenant-scoped routes like /tenants/:id/usage) without trusting
 * anything client-side. Works for both auth modes — tenantId is resolved by
 * AuthGuard from the Firebase `tenant` custom claim or the API token.
 */
@ApiBearerAuth("bearer")
@Controller("me")
export class MeController {
  @ApiEndpoint({ summary: "Get the authenticated principal", ok: MeResponse })
  @Get()
  @UserScoped()
  me(@CurrentPrincipal() principal: Principal): {
    tenantId: string;
    subject?: string;
  } {
    return { tenantId: principal.tenantId, subject: principal.subject };
  }

  /**
   * The feature flags for THIS tenant — the SPA reads this to gate UI. Evaluated
   * server-side keyed on the authenticated tenantId; the caller only ever learns its
   * own flags, and the Flagsmith key never leaves the server. Fail-safe: if the flag
   * provider is unconfigured/unreachable, every flag resolves to its safe code default.
   */
  @ApiEndpoint({
    summary: "Get this tenant's feature flags",
    ok: MeFlagsResponse,
  })
  @Get("flags")
  @UserScoped()
  async flags(
    @CurrentPrincipal() principal: Principal,
  ): Promise<MeFlagsResponse> {
    return { flags: await getAllFlags(principal.tenantId) };
  }
}
