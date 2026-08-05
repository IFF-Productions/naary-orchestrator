import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ApiTokenService } from "./api-token.service";
import { AuthGuard } from "./auth.guard";
import { CliRefreshTokenService } from "./cli-refresh-token.service";
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
    // No controller consumes this yet — `/auth/cli/{start,exchange,refresh}` is #1078 slice 3.
    // Registered now so the seam exists (and is DI-resolvable) where slice 3 will plug in.
    CliRefreshTokenService,
    { provide: FirebaseVerifier, useFactory: () => new FirebaseVerifier() },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [ApiTokenService, CliRefreshTokenService],
})
export class AuthModule {}
