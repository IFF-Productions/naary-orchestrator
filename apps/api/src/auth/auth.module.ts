import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ApiTokenService } from "./api-token.service";
import { AuthGuard } from "./auth.guard";
import { FirebaseVerifier } from "./firebase-verifier";
import { MeController } from "./me.controller";
import { TokensController } from "./tokens.controller";

/** Registers the dual-auth (Firebase ID token + API token) guard globally and
 *  exposes ApiTokenService for minting. FirebaseVerifier is built from env —
 *  Firebase auth is OFF unless a service account is configured, so API-token-only
 *  deployments are unchanged. */
@Global()
@Module({
  controllers: [MeController, TokensController],
  providers: [
    ApiTokenService,
    { provide: FirebaseVerifier, useFactory: () => new FirebaseVerifier() },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [ApiTokenService],
})
export class AuthModule {}
