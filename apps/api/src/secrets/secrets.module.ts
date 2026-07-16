import { Module } from "@nestjs/common";
import { CredentialsService } from "@naary/secrets";
import { EnvironmentsModule } from "../environments/environments.module";
import { SecretsController } from "./secrets.controller";

@Module({
  imports: [EnvironmentsModule], // SecretsController resolves the active env for env-scoped creds
  controllers: [SecretsController],
  // CredentialsService is a plain class from @naary/secrets; build it once.
  // Reads ENCRYPTION_KEY at construction (fail-fast at boot if missing).
  providers: [
    { provide: CredentialsService, useFactory: () => new CredentialsService() },
  ],
})
export class SecretsModule {}
