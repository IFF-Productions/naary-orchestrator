import { Module } from "@nestjs/common";
import { EnvironmentsModule } from "../environments/environments.module";
import { TurnstileConfigController } from "./turnstile-config.controller";
import { TurnstileConfigService } from "./turnstile-config.service";

/** Turnstile bot-protection config (docs/design/TURNSTILE-BOT-PROTECTION.md). The service reads
 *  ENCRYPTION_KEY at construction (SecretStore) — fail-fast at boot if missing. */
@Module({
  imports: [EnvironmentsModule], // resolve the active env for env-scoped config
  controllers: [TurnstileConfigController],
  // useFactory so Nest builds the SecretStore (a plain @naary/secrets class) rather than trying to
  // DI it; SecretStore reads ENCRYPTION_KEY at construction (fail-fast at boot).
  providers: [
    {
      provide: TurnstileConfigService,
      useFactory: () => new TurnstileConfigService(),
    },
  ],
  exports: [TurnstileConfigService], // Slice 2's public form/chat verify reuses it
})
export class TurnstileConfigModule {}
