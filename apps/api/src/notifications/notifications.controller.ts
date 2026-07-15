import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Post,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { ApiEndpoint } from "../swagger/api-decorators";
import { SaveNotificationChannelDto } from "./notification.dto";
import {
  NotificationChannelResponse,
  TestNotificationResponse,
} from "./notification.response";
import {
  type NotificationChannelView,
  NotificationsService,
} from "./notifications.service";

/** tenantId from the path; AuthGuard enforces path-tenant == token-tenant. Each channel
 *  (slack/teams/…) is addressed by its type segment and configured independently. */
@ApiBearerAuth("bearer")
@Controller("tenants/:id/notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @ApiEndpoint({
    summary: "List notification channels",
    description:
      "Every known channel (Slack, Teams, …) with its saved config or defaults — each configured independently.",
    ok: [NotificationChannelResponse],
  })
  @Get()
  list(@Param("id") tenantId: string): Promise<NotificationChannelView[]> {
    return this.notifications.list(tenantId);
  }

  @ApiEndpoint({
    summary: "Update one notification channel",
    description:
      "Upserts a single channel's config (identified by :type). Other channels are untouched.",
    ok: NotificationChannelResponse,
  })
  @Put(":type")
  saveChannel(
    @Param("id") tenantId: string,
    @Param("type") type: string,
    @Body() body: SaveNotificationChannelDto,
  ): Promise<NotificationChannelView> {
    return this.notifications.saveChannel(tenantId, type, body);
  }

  @ApiEndpoint({
    summary: "Delete one notification channel's config",
    description: "Removes the channel's saved config (idempotent).",
    ok: TestNotificationResponse,
  })
  @Delete(":type")
  @HttpCode(200)
  async deleteChannel(
    @Param("id") tenantId: string,
    @Param("type") type: string,
  ): Promise<{ ok: true; status: number }> {
    await this.notifications.deleteChannel(tenantId, type);
    return { ok: true, status: 200 };
  }

  /** Send a one-off test message to ONE channel's webhook. 400 if unconfigured, the URL
   *  is blocked (SSRF), or the webhook returns a non-2xx / is unreachable. */
  @ApiEndpoint({
    summary: "Send a test notification to one channel",
    description:
      "POSTs a sample message to that channel's webhook so you can confirm delivery + formatting from your own channel.",
    ok: TestNotificationResponse,
  })
  @Post(":type/test")
  @HttpCode(200)
  sendTest(
    @Param("id") tenantId: string,
    @Param("type") type: string,
  ): Promise<{ ok: true; status: number }> {
    return this.notifications.sendTest(tenantId, type);
  }
}
