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
import { EnvironmentSel } from "../auth/tenant.decorator";
import { EnvironmentsService } from "../environments/environments.service";
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

/** tenantId from the path; AuthGuard enforces path-tenant == token-tenant. Channels are
 *  ENV-scoped (Slice 6b): every route resolves the ACTIVE environment (X-Environment-Id,
 *  absent = tenant default) and only sees that env's channels. A tenant may have ANY
 *  NUMBER of channels per type per env; each is addressed by its row id. */
@ApiBearerAuth("bearer")
@Controller("tenants/:id/notifications")
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly environments: EnvironmentsService,
  ) {}

  @ApiEndpoint({
    summary: "List notification channels",
    description:
      "Every channel configured in the active environment (any number of Slack/Teams webhooks), in a stable order.",
    ok: [NotificationChannelResponse],
  })
  @Get()
  async list(
    @Param("id") tenantId: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<NotificationChannelView[]> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.notifications.list(tenantId, envId);
  }

  @ApiEndpoint({
    summary: "Add a notification channel",
    description:
      "Creates a new channel of the given type in the active environment — a tenant can have several per type (e.g. two Slack webhooks for #alerts and #oncall).",
    created: NotificationChannelResponse,
  })
  @Post()
  @HttpCode(201)
  async createChannel(
    @Param("id") tenantId: string,
    @Body() body: CreateNotificationChannelDto,
    @EnvironmentSel() envSel?: string,
  ): Promise<NotificationChannelView> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    const { type, ...patch } = body;
    return this.notifications.createChannel(tenantId, envId, type, patch);
  }

  @ApiEndpoint({
    summary: "Update one notification channel",
    description:
      "Patches a single channel's config (identified by :channelId). Other channels are untouched.",
    ok: NotificationChannelResponse,
  })
  @Patch(":channelId")
  async updateChannel(
    @Param("id") tenantId: string,
    @Param("channelId") channelId: string,
    @Body() body: UpdateNotificationChannelDto,
    @EnvironmentSel() envSel?: string,
  ): Promise<NotificationChannelView> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.notifications.updateChannel(tenantId, envId, channelId, body);
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
    @EnvironmentSel() envSel?: string,
  ): Promise<{ ok: true; status: number }> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    await this.notifications.deleteChannel(tenantId, envId, channelId);
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
  async sendTest(
    @Param("id") tenantId: string,
    @Param("channelId") channelId: string,
    @EnvironmentSel() envSel?: string,
  ): Promise<{ ok: true; status: number }> {
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.notifications.sendTest(tenantId, envId, channelId);
  }
}
