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
import { VariableResponse } from "./variable.response";
import { type VariableView, VariablesService } from "./variables.service";

/**
 * Global Variables CRUD — non-secret workspace config, scoped to the ACTIVE environment
 * (X-Environment-Id → resolved via EnvironmentsService). Referenced in expressions as
 * `{{ $vars.KEY }}`; the worker injects them into the run ctx at start.
 */
@ApiBearerAuth("bearer")
@Controller("variables")
export class VariablesController {
  constructor(
    private readonly variables: VariablesService,
    private readonly environments: EnvironmentsService,
  ) {}

  @ApiEndpoint({
    summary: "List variables (active environment)",
    ok: [VariableResponse],
  })
  @Get()
  async list(
    @TenantId() tenantId: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<VariableView[]> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.variables.list(tenantId, envId);
  }

  @ApiEndpoint({
    summary: "Set a variable (active environment)",
    ok: VariableResponse,
  })
  @Put(":key")
  async set(
    @TenantId() tenantId: string,
    @Param("key") key: string,
    @Body() body: { value?: string },
    @EnvironmentSel() envSel?: string,
  ): Promise<VariableView> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.variables.upsert(tenantId, envId, key, body?.value ?? "");
  }

  @ApiEndpoint({ summary: "Delete a variable (active environment)" })
  @Delete(":key")
  @HttpCode(204)
  async remove(
    @TenantId() tenantId: string,
    @Param("key") key: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<void> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    await this.variables.remove(tenantId, envId, key);
  }
}
