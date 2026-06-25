import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
} from "@nestjs/common";
import {
  ConnectionService,
  type ConnectionView,
  type CreateConnectionInput,
} from "@naary/connections";

@Controller("tenants/:id/connections")
export class ConnectionsController {
  constructor(private readonly connections: ConnectionService) {}

  @Post()
  create(
    @Param("id") tenantId: string,
    @Body() body: CreateConnectionInput,
  ): Promise<ConnectionView> {
    return this.connections.create(tenantId, body);
  }

  @Get()
  list(@Param("id") tenantId: string): Promise<ConnectionView[]> {
    return this.connections.list(tenantId);
  }

  @Delete(":connectionId")
  @HttpCode(204)
  remove(
    @Param("id") tenantId: string,
    @Param("connectionId") connectionId: string,
  ): Promise<void> {
    return this.connections.remove(tenantId, connectionId);
  }
}
