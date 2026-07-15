import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { EnvironmentSel } from "../auth/tenant.decorator";
import { EnvironmentsService } from "../environments/environments.service";
import { ApiEndpoint } from "../swagger/api-decorators";
import {
  DeletedResponse,
  RegisteredWebhookResponse,
  RotatedSecretResponse,
  WebhookEndpointResponse,
} from "./webhook.response";
import {
  type RegisteredWebhook,
  type WebhookEndpointView,
  WebhookService,
} from "./webhook.service";
import { RegisterWebhookDto } from "./register-webhook.dto";
import { UpdateWebhookDto } from "./update-webhook.dto";

@ApiBearerAuth("bearer")
@Controller("tenants/:id/webhooks")
export class WebhooksController {
  constructor(
    private readonly webhooks: WebhookService,
    private readonly environments: EnvironmentsService,
  ) {}

  /** Register a webhook trigger; returns the ingress path + signing secret (once). */
  @ApiEndpoint({
    summary: "Register a webhook trigger",
    description: "Returns the ingress path + signing secret (returned once).",
    created: RegisteredWebhookResponse,
  })
  @Post()
  async register(
    @Param("id") tenantId: string,
    @Body() body: RegisterWebhookDto,
    @EnvironmentSel() envSel?: string,
  ): Promise<RegisteredWebhook> {
    // Bind the webhook to the registering user's ACTIVE env — it fires runs there.
    const envId = await this.environments.resolveEnvId(tenantId, envSel);
    return this.webhooks.createEndpoint(
      tenantId,
      envId,
      body.workflowId,
      body.provider,
    );
  }

  /** List the tenant's webhook endpoints (never includes the signing secret). */
  @ApiEndpoint({
    summary: "List webhook endpoints",
    description: "Never includes the signing secret.",
    ok: [WebhookEndpointResponse],
  })
  @Get()
  list(@Param("id") tenantId: string): Promise<WebhookEndpointView[]> {
    return this.webhooks.list(tenantId);
  }

  /** Update a webhook endpoint's config (workflow/provider) IN PLACE — same id/URL/secret. */
  @ApiEndpoint({
    summary: "Update a webhook endpoint",
    description:
      "Retarget the workflow and/or change the provider in place. The id, ingress URL and signing secret are unchanged. Tenant-scoped; 404 if it isn't this tenant's.",
    ok: WebhookEndpointResponse,
    notFound: true,
  })
  @Patch(":endpointId")
  async update(
    @Param("id") tenantId: string,
    @Param("endpointId") endpointId: string,
    @Body() body: UpdateWebhookDto,
  ): Promise<WebhookEndpointView> {
    const view = await this.webhooks.updateEndpoint(tenantId, endpointId, body);
    if (!view) throw new NotFoundException("Webhook endpoint not found");
    return view;
  }

  /** Rotate the signing secret; returns the NEW secret once. Same id/URL. */
  @ApiEndpoint({
    summary: "Rotate a webhook endpoint's signing secret",
    description:
      "Mints a new HMAC secret (returned once) and stores it encrypted; the endpoint id/URL are unchanged. Reconfigure the provider with the new secret. Tenant-scoped; 404 if it isn't this tenant's.",
    ok: RotatedSecretResponse,
    notFound: true,
  })
  @Post(":endpointId/rotate-secret")
  @HttpCode(200)
  async rotateSecret(
    @Param("id") tenantId: string,
    @Param("endpointId") endpointId: string,
  ): Promise<{ signingSecret: string }> {
    const res = await this.webhooks.rotateSecret(tenantId, endpointId);
    if (!res) throw new NotFoundException("Webhook endpoint not found");
    return res;
  }

  /** Delete a webhook endpoint. Tenant-scoped; 404 if it isn't this tenant's. */
  @ApiEndpoint({
    summary: "Delete a webhook endpoint",
    description: "Tenant-scoped; 404 if it isn't this tenant's.",
    ok: DeletedResponse,
    notFound: true,
  })
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
