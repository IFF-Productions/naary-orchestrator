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
import { ApiEndpoint } from "../swagger/api-decorators";
import { ConnectionResponse } from "./connection.response";
import { CreateConnectionDto } from "./create-connection.dto";

@ApiBearerAuth("bearer")
@Controller("tenants/:id/connections")
export class ConnectionsController {
  constructor(private readonly connections: ConnectionService) {}

  @ApiEndpoint({
    summary: "Create a connection",
    description:
      "Stores a connection for the tenant; secret token (PAT/DSN) is encrypted, never returned.",
    created: ConnectionResponse,
  })
  @Post()
  create(
    @Param("id") tenantId: string,
    @Body() body: CreateConnectionDto,
  ): Promise<ConnectionView> {
    return this.connections.create(tenantId, body);
  }

  @ApiEndpoint({
    summary: "List connections",
    ok: [ConnectionResponse],
  })
  @Get()
  list(@Param("id") tenantId: string): Promise<ConnectionView[]> {
    return this.connections.list(tenantId);
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
