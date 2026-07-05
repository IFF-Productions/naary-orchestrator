import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import { SaveNotificationsDto } from "./notification.dto";
import {
  type NotificationSettingsView,
  NotificationsService,
} from "./notifications.service";

/** tenantId from the path; AuthGuard enforces path-tenant == token-tenant. */
@Controller("tenants/:id/notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  get(@Param("id") tenantId: string): Promise<NotificationSettingsView> {
    return this.notifications.get(tenantId);
  }

  @Put()
  save(
    @Param("id") tenantId: string,
    @Body() body: SaveNotificationsDto,
  ): Promise<NotificationSettingsView> {
    return this.notifications.save(tenantId, body);
  }
}
