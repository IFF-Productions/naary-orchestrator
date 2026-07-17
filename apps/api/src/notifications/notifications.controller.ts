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
import { ApiEndpoint } from "../swagger/api-decorators";
import {
  CreateNotificationChannelDto,
  UpdateNotificationChannelDto,
} from "./notification.dto";
import {
  NotificationChannelResponse,
  TestNotificationResponse,
} from "./notification.response";
import {
  type NotificationChannelView,
  NotificationsService,
} from "./notifications.service";

/** tenantId from the path; AuthGuard enforces path-tenant == token-tenant. A tenant may
 *  have ANY NUMBER of channels per type (N Slack + N Teams webhooks); each is addressed
 *  by its row id. */
@ApiBearerAuth("bearer")
@Controller("tenants/:id/notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @ApiEndpoint({
    summary: "List notification channels",
    description:
      "Every configured channel (any number of Slack/Teams webhooks), in a stable order.",
    ok: [NotificationChannelResponse],
  })
  @Get()
  list(@Param("id") tenantId: string): Promise<NotificationChannelView[]> {
    return this.notifications.list(tenantId);
  }

  @ApiEndpoint({
    summary: "Add a notification channel",
    description:
      "Creates a new channel of the given type — a tenant can have several per type (e.g. two Slack webhooks for #alerts and #oncall).",
    created: NotificationChannelResponse,
  })
  @Post()
  @HttpCode(201)
  createChannel(
    @Param("id") tenantId: string,
    @Body() body: CreateNotificationChannelDto,
  ): Promise<NotificationChannelView> {
    const { type, ...patch } = body;
    return this.notifications.createChannel(tenantId, type, patch);
  }

  @ApiEndpoint({
    summary: "Update one notification channel",
    description:
      "Patches a single channel's config (identified by :channelId). Other channels are untouched.",
    ok: NotificationChannelResponse,
  })
  @Patch(":channelId")
  updateChannel(
    @Param("id") tenantId: string,
    @Param("channelId") channelId: string,
    @Body() body: UpdateNotificationChannelDto,
  ): Promise<NotificationChannelView> {
    return this.notifications.updateChannel(tenantId, channelId, body);
  }

  @ApiEndpoint({
    summary: "Delete one notification channel",
    description: "Removes the channel (idempotent).",
    ok: TestNotificationResponse,
  })
  @Delete(":channelId")
  @HttpCode(200)
  async deleteChannel(
    @Param("id") tenantId: string,
    @Param("channelId") channelId: string,
  ): Promise<{ ok: true; status: number }> {
    await this.notifications.deleteChannel(tenantId, channelId);
    return { ok: true, status: 200 };
  }

  /** Send a one-off test message to ONE channel's webhook. 404 for an unknown channel;
   *  400 if unconfigured, the URL is blocked (SSRF), or the webhook returns a non-2xx /
   *  is unreachable. */
  @ApiEndpoint({
    summary: "Send a test notification to one channel",
    description:
      "POSTs a sample message to that channel's webhook so you can confirm delivery + formatting from your own channel.",
    ok: TestNotificationResponse,
  })
  @Post(":channelId/test")
  @HttpCode(200)
  sendTest(
    @Param("id") tenantId: string,
    @Param("channelId") channelId: string,
  ): Promise<{ ok: true; status: number }> {
    return this.notifications.sendTest(tenantId, channelId);
  }
}
