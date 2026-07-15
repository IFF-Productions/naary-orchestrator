import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { TenantId } from "../auth/tenant.decorator";
import { ApiEndpoint } from "../swagger/api-decorators";
import { CreateEnvironmentDto, RenameEnvironmentDto } from "./environment.dto";
import { EnvironmentResponse } from "./environment.response";
import {
  type EnvironmentView,
  EnvironmentsService,
} from "./environments.service";

/** tenantId from the path; AuthGuard enforces path-tenant == token-tenant. Environments are the
 *  per-tenant sandbox/UAT/prod spaces (design docs/design/ENVIRONMENTS.md). */
@ApiBearerAuth("bearer")
@Controller("tenants/:id/environments")
export class EnvironmentsController {
  constructor(private readonly environments: EnvironmentsService) {}

  @ApiEndpoint({
    summary: "List environments",
    description:
      "All environments for the tenant (the default 'Production' env is created on first access).",
    ok: [EnvironmentResponse],
  })
  @Get()
  list(@Param("id") tenantId: string): Promise<EnvironmentView[]> {
    return this.environments.list(tenantId);
  }

  @ApiEndpoint({
    summary: "Create an environment",
    created: EnvironmentResponse,
  })
  @Post()
  create(
    @Param("id") tenantId: string,
    @Body() body: CreateEnvironmentDto,
  ): Promise<EnvironmentView> {
    return this.environments.create(tenantId, body);
  }

  @ApiEndpoint({
    summary: "Rename an environment",
    ok: EnvironmentResponse,
    notFound: true,
  })
  @Patch(":envId")
  rename(
    @Param("id") tenantId: string,
    @Param("envId") envId: string,
    @Body() body: RenameEnvironmentDto,
  ): Promise<EnvironmentView> {
    return this.environments.rename(tenantId, envId, body.name ?? "");
  }

  @ApiEndpoint({
    summary: "Delete an environment",
    description: "Refused for the default environment.",
    ok: EnvironmentResponse,
    notFound: true,
  })
  @Delete(":envId")
  @HttpCode(200)
  async remove(
    @Param("id") tenantId: string,
    @Param("envId") envId: string,
  ): Promise<{ ok: true }> {
    await this.environments.remove(tenantId, envId);
    return { ok: true };
  }
}
