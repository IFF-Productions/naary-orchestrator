import { Logger, Module } from "@nestjs/common";
import {
  CredentialsService,
  assertSecretProviderConfig,
  createKeyEncryptor,
} from "@naary/secrets";
import { EnvironmentsModule } from "../environments/environments.module";
import { SecretsController } from "./secrets.controller";

/** Boot gate for the credential layer. Two assertions, both fail-fast at boot rather than
 *  on a user's first save:
 *   - ENCRYPTION_KEY present + well-formed (still required even with an external store:
 *     pre-existing rows and every non-BYOK secret stay DB-encrypted);
 *   - SECRET_PROVIDER (#458) is a supported mode AND fully configured — an operator who
 *     sets `vault` without VAULT_ADDR/VAULT_TOKEN must not boot into a state where saving
 *     a key silently 500s.
 *  Logs the MODE only (`db` / `vault`) — never a token or any material. */
function buildCredentialsService(): CredentialsService {
  createKeyEncryptor();
  const mode = assertSecretProviderConfig();
  new Logger("SecretsModule").log(`secret store: ${mode}`);
  return new CredentialsService();
}

@Module({
  imports: [EnvironmentsModule], // SecretsController resolves the active env for env-scoped creds
  controllers: [SecretsController],
  // CredentialsService is a plain class from @naary/secrets; build it once.
  providers: [
    { provide: CredentialsService, useFactory: buildCredentialsService },
  ],
})
export class SecretsModule {}
