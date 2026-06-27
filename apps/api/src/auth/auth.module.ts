import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ApiTokenService } from "./api-token.service";
import { AuthGuard } from "./auth.guard";
import { MeController } from "./me.controller";
import { OidcVerifier } from "./oidc-verifier";

/** Registers the dual-auth (Keycloak JWT + API token) guard globally and exposes
 *  ApiTokenService for minting. OidcVerifier is built from env — OIDC is OFF
 *  unless OIDC_ISSUER is set, so existing API-token-only deployments are unchanged. */
@Global()
@Module({
  controllers: [MeController],
  providers: [
    ApiTokenService,
    { provide: OidcVerifier, useFactory: () => new OidcVerifier() },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [ApiTokenService],
})
export class AuthModule {}
