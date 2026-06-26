import { Module } from "@nestjs/common";
import { ExecutionsModule } from "../executions/executions.module";
import { HooksController } from "./hooks.controller";
import { WebhookService } from "./webhook.service";
import { WebhooksController } from "./webhooks.controller";

@Module({
  imports: [ExecutionsModule], // HooksController reuses ExecutionsService.startWebhook
  controllers: [WebhooksController, HooksController],
  // WebhookService's only constructor param is an OPTIONAL interface (KeyEncryptor,
  // lazily built) — Nest's DI can't resolve an interface type, so build it via a
  // factory (same pattern as CredentialsService / OidcVerifier / ConnectionService).
  providers: [
    { provide: WebhookService, useFactory: () => new WebhookService() },
  ],
})
export class WebhooksModule {}
