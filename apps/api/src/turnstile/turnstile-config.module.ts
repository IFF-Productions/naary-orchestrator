import { Module } from "@nestjs/common";
import { SecretStore } from "@naary/secrets";
import { EnvironmentsModule } from "../environments/environments.module";
import { AppCheckVerifier } from "./app-check-verifier";
import { TurnstileConfigController } from "./turnstile-config.controller";
import { TurnstileConfigService } from "./turnstile-config.service";

/** Tenant bot-protection config: Cloudflare Turnstile (tenant keys) or Firebase App Check (the
 *  platform's) — docs/design/TURNSTILE-BOT-PROTECTION.md + TENANT-BOT-GATE-PROVIDERS.md. The service
 *  reads ENCRYPTION_KEY at construction (SecretStore) — fail-fast at boot if missing. */
@Module({
  imports: [EnvironmentsModule], // resolve the active env for env-scoped config
  controllers: [TurnstileConfigController],
  // useFactory so Nest builds the SecretStore + AppCheckVerifier (plain classes, not Nest providers)
  // rather than trying to DI them; SecretStore reads ENCRYPTION_KEY at construction (fail-fast at
  // boot), and AppCheckVerifier reads the Firebase service account (absent ⇒ app_check unavailable).
  providers: [
    {
      provide: TurnstileConfigService,
      useFactory: () =>
        new TurnstileConfigService(new SecretStore(), new AppCheckVerifier()),
    },
  ],
  exports: [TurnstileConfigService], // Slice 2's public form/chat verify reuses it
})
export class TurnstileConfigModule {}
