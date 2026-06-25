import {
  Body,
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { ExecutionsService } from "../executions/executions.service";
import { type WebhookProvider, WebhookService } from "./webhook.service";

/** Express request augmented by NestFactory({ rawBody: true }). */
interface RawReq {
  rawBody?: Buffer;
}

@Controller("hooks")
export class HooksController {
  constructor(
    private readonly webhooks: WebhookService,
    private readonly executions: ExecutionsService,
  ) {}

  /**
   * Webhook ingress: verify signature over the RAW body → dedupe on delivery id →
   * start the workflow with the event as the trigger node's output.
   */
  @Post(":endpointId")
  @HttpCode(202)
  async ingress(
    @Param("endpointId") endpointId: string,
    @Req() req: RawReq,
    @Body() event: unknown,
    @Headers() headers: Record<string, string>,
  ): Promise<{ status: string; workflowId?: string }> {
    const endpoint = await this.webhooks.getEndpoint(endpointId);
    if (!endpoint) {
      throw new NotFoundException("Unknown webhook endpoint");
    }
    const provider = endpoint.provider as WebhookProvider;

    // HMAC over the exact received bytes (never the re-serialized JSON).
    const rawBody = req.rawBody ?? Buffer.alloc(0);
    const signature = headers["x-hub-signature-256"];
    if (
      !this.webhooks.verifySignature(
        provider,
        rawBody,
        signature,
        endpoint.signingSecret,
      )
    ) {
      throw new UnauthorizedException("Invalid signature");
    }

    // Dedupe AFTER verifying (don't let unsigned requests touch the store).
    const deliveryId = headers[this.webhooks.deliveryHeaderFor(provider)];
    if (
      deliveryId &&
      (await this.webhooks.isDuplicateDelivery(endpointId, deliveryId))
    ) {
      return { status: "duplicate_ignored" }; // 2xx so the provider stops retrying
    }

    const { workflowId } = await this.executions.startWebhook(
      endpoint.tenantId,
      event,
    );
    return { status: "started", workflowId };
  }
}
