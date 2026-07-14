import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { ApiEndpoint } from "../swagger/api-decorators";
import { SaveNotificationsDto } from "./notification.dto";
import {
  NotificationSettingsResponse,
  TestNotificationResponse,
} from "./notification.response";
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

  /** Send a one-off test message to the configured webhook. 400 if unconfigured, the URL
   *  is blocked (SSRF), or the webhook returns a non-2xx / is unreachable. */
  @ApiEndpoint({
    summary: "Send a test notification",
    description:
      "POSTs a sample message to the configured webhook so you can confirm delivery + formatting from your own channel.",
    ok: TestNotificationResponse,
  })
  @Post("test")
  @HttpCode(200)
  sendTest(
    @Param("id") tenantId: string,
  ): Promise<{ ok: true; status: number }> {
    return this.notifications.sendTest(tenantId);
  }
}
