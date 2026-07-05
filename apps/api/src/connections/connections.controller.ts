import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ConnectionService, type ConnectionView } from "@naary/connections";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { CreateConnectionDto } from "./create-connection.dto";

@Controller("tenants/:id/connections")
@UseGuards(RolesGuard)
export class ConnectionsController {
  constructor(private readonly connections: ConnectionService) {}

  @Post()
  create(
    @Param("id") tenantId: string,
    @Body() body: CreateConnectionDto,
  ): Promise<ConnectionView> {
    return this.connections.create(tenantId, body);
  }

  @Get()
  list(@Param("id") tenantId: string): Promise<ConnectionView[]> {
    return this.connections.list(tenantId);
  }

  /** Disconnect + delete the stored secret. Admin+ (design §5). */
  @Delete(":connectionId")
  @Roles("admin")
  @HttpCode(204)
  remove(
    @Param("id") tenantId: string,
    @Param("connectionId") connectionId: string,
  ): Promise<void> {
    return this.connections.remove(tenantId, connectionId);
  }
}
