import { Body, Controller, Param, Post } from "@nestjs/common";
import { type RegisteredWebhook, WebhookService } from "./webhook.service";
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
}
