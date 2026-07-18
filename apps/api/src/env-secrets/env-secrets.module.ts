import { Module } from "@nestjs/common";
import { SecretStore } from "@naary/secrets";
import { EnvironmentsModule } from "../environments/environments.module";
import { EnvSecretsController } from "./env-secrets.controller";
import { EnvSecretsService } from "./env-secrets.service";

/** Environment Secrets ($secrets) — write-only, env-scoped named secrets for `{{ $secrets.NAME }}`.
 *  SecretStore is a plain class from @naary/secrets (AES-256-GCM via ENCRYPTION_KEY); build it once. */
@Module({
  imports: [EnvironmentsModule],
  controllers: [EnvSecretsController],
  providers: [
    { provide: SecretStore, useFactory: () => new SecretStore() },
    EnvSecretsService,
  ],
  exports: [EnvSecretsService],
})
export class EnvSecretsModule {}
