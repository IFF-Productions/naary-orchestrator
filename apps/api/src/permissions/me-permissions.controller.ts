import { Controller, Get } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import {
  CurrentPrincipal,
  EnvironmentSel,
  type Principal,
} from "../auth/tenant.decorator";
import { EnvironmentsService } from "../environments/environments.service";
import { ApiEndpoint } from "../swagger/api-decorators";
import { EffectivePermissionsResponse } from "./group.response";
import {
  type EffectivePermissions,
  PermissionsService,
} from "./permissions.service";

/**
 * The caller's effective workflow permissions in the ACTIVE workspace + environment
 * (RBAC-GROUPS.md §4 "Mechanism") — the SPA reads this to gate affordances (G2: hide
 * Run/Edit/Delete buttons the server would 403 anyway). Workspace-scoped (NOT @UserScoped):
 * the matrix is meaningless without an active workspace, and the guard resolves + checks it.
 */
@ApiBearerAuth("bearer")
@Controller("me")
export class MePermissionsController {
  constructor(
    private readonly permissions: PermissionsService,
    private readonly environments: EnvironmentsService,
  ) {}

  @ApiEndpoint({
    summary: "Get my effective workflow permissions",
    description:
      "The effective six-verb matrix for the active workspace + environment. `restricted:false` = full access.",
    ok: EffectivePermissionsResponse,
  })
  @Get("permissions")
  async permissions_(
    @CurrentPrincipal() principal: Principal,
    @EnvironmentSel() envSel?: string,
  ): Promise<EffectivePermissions> {
    const envId = await this.environments.resolveEnvId(
      principal.tenantId,
      envSel,
    );
    return this.permissions.getEffective(principal, envId);
  }
}
