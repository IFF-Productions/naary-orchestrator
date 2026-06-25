import { Body, Controller, Param, Post } from "@nestjs/common";
import {
  type RegisteredWebhook,
  WebhookService,
  type WebhookProvider,
} from "./webhook.service";

@Controller("tenants/:id/webhooks")
export class WebhooksController {
  constructor(private readonly webhooks: WebhookService) {}

  /** Register a webhook trigger; returns the ingress path + signing secret (once). */
  @Post()
  register(
    @Param("id") tenantId: string,
    @Body() body: { workflowId: string; provider: WebhookProvider },
  ): Promise<RegisteredWebhook> {
    return this.webhooks.createEndpoint(
      tenantId,
      body.workflowId,
      body.provider,
    );
  }
}
