import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { ApiEndpoint } from "../swagger/api-decorators";
import { SaveNotificationsDto } from "./notification.dto";
import { NotificationSettingsResponse } from "./notification.response";
import {
  type NotificationSettingsView,
  NotificationsService,
} from "./notifications.service";

/** tenantId from the path; AuthGuard enforces path-tenant == token-tenant. */
@ApiBearerAuth("bearer")
@Controller("tenants/:id/notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @ApiEndpoint({
    summary: "Get notification settings",
    ok: NotificationSettingsResponse,
  })
  @Get()
  get(@Param("id") tenantId: string): Promise<NotificationSettingsView> {
    return this.notifications.get(tenantId);
  }

  @ApiEndpoint({
    summary: "Update notification settings",
    ok: NotificationSettingsResponse,
  })
  @Put()
  save(
    @Param("id") tenantId: string,
    @Body() body: SaveNotificationsDto,
  ): Promise<NotificationSettingsView> {
    return this.notifications.save(tenantId, body);
  }
}
