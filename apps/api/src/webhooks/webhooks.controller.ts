import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
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

  /** Delete a webhook endpoint. Tenant-scoped; 404 if it isn't this tenant's. */
  @Delete(":endpointId")
  async remove(
    @Param("id") tenantId: string,
    @Param("endpointId") endpointId: string,
  ): Promise<{ deleted: true }> {
    const ok = await this.webhooks.deleteEndpoint(tenantId, endpointId);
    if (!ok) throw new NotFoundException("Webhook endpoint not found");
    return { deleted: true };
  }
}
