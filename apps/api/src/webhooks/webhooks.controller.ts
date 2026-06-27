import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import {
  type RegisteredWebhook,
  type WebhookEndpointView,
  WebhookService,
} from "./webhook.service";
import { RegisterWebhookDto } from "./register-webhook.dto";

@Controller("tenants/:id/webhooks")
export class WebhooksController {
  constructor(private readonly webhooks: WebhookService) {}

  /** Register a webhook trigger; returns the ingress path + signing secret (once). */
  @Post()
  register(
    @Param("id") tenantId: string,
    @Body() body: RegisterWebhookDto,
  ): Promise<RegisteredWebhook> {
    return this.webhooks.createEndpoint(
      tenantId,
      body.workflowId,
      body.provider,
    );
  }

  /** List the tenant's webhook endpoints (never includes the signing secret). */
  @Get()
  list(@Param("id") tenantId: string): Promise<WebhookEndpointView[]> {
    return this.webhooks.list(tenantId);
  }
}
