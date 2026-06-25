import { Module } from "@nestjs/common";
import { ExecutionsModule } from "../executions/executions.module";
import { HooksController } from "./hooks.controller";
import { WebhookService } from "./webhook.service";
import { WebhooksController } from "./webhooks.controller";

@Module({
  imports: [ExecutionsModule], // HooksController reuses ExecutionsService.startWebhook
  controllers: [WebhooksController, HooksController],
  providers: [WebhookService],
})
export class WebhooksModule {}
