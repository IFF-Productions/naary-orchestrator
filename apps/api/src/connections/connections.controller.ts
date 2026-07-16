import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { ConnectionService, type ConnectionView } from "@naary/connections";
import { EnvironmentSel } from "../auth/tenant.decorator";
import { EnvironmentsService } from "../environments/environments.service";
import { ApiEndpoint } from "../swagger/api-decorators";
import { ConnectionResponse } from "./connection.response";
import { CreateConnectionDto } from "./create-connection.dto";

@ApiBearerAuth("bearer")
@Controller("tenants/:id/connections")
export class ConnectionsController {
  constructor(
    private readonly connections: ConnectionService,
    private readonly environments: EnvironmentsService,
  ) {}

  @ApiEndpoint({
    summary: "Create a connection",
    description:
      "Stores a connection for the tenant; secret token (PAT/DSN) is encrypted, never returned.",
    created: ConnectionResponse,
  })
  @Post()
  async create(
    @Param("id") tenantId: string,
    @Body() body: CreateConnectionDto,
    @EnvironmentSel() envSel?: string,
  ): Promise<ConnectionView> {
    // Env-scoped (Slice 5): the connection lands in the caller's active env — a sandbox run binds
    // to sandbox integrations, prod to prod.
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.connections.create(tenantId, envId, body);
  }

  @ApiEndpoint({
    summary: "List connections",
    ok: [ConnectionResponse],
  })
  @Get()
  async list(
    @Param("id") tenantId: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<ConnectionView[]> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.connections.list(tenantId, envId);
  }

  @ApiEndpoint({
    summary: "Delete a connection",
    description:
      "Removes the connection and its stored secret (204 No Content).",
  })
  @Delete(":connectionId")
  @HttpCode(204)
  remove(
    @Param("id") tenantId: string,
    @Param("connectionId") connectionId: string,
  ): Promise<void> {
    return this.connections.remove(tenantId, connectionId);
  }
}
