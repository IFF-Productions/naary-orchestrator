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
import { GraphsService } from "../graphs/graphs.service";
import { ApiEndpoint } from "../swagger/api-decorators";
import { ConnectionResponse } from "./connection.response";
import { CreateConnectionDto } from "./create-connection.dto";

@ApiBearerAuth("bearer")
@Controller("tenants/:id/connections")
export class ConnectionsController {
  constructor(
    private readonly connections: ConnectionService,
    private readonly environments: EnvironmentsService,
    private readonly graphs: GraphsService,
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
  ): Promise<
    Array<
      ConnectionView & {
        usedByNodeCount: number;
        credentialLast4: string | null;
      }
    >
  > {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    // Connections + their reference counts + credential last-4 (#471) in parallel — all env-scoped
    // to `envId`. The last-4 is decrypted in the service and only the 4-char fragment reaches here;
    // the full token never crosses this boundary.
    const [conns, usage, last4] = await Promise.all([
      this.connections.list(tenantId, envId),
      this.graphs.connectionUsageCounts(tenantId, envId),
      this.connections.credentialLast4Map(tenantId, envId),
    ]);
    return conns.map((c) => ({
      ...c,
      usedByNodeCount: usage[c.id] ?? 0,
      credentialLast4: last4[c.id] ?? null,
    }));
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
