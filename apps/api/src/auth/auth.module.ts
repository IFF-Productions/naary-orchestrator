import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ApiTokenService } from "./api-token.service";
import { AuthGuard } from "./auth.guard";

/** Registers the bearer AuthGuard globally and exposes ApiTokenService for minting. */
@Global()
@Module({
  providers: [ApiTokenService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [ApiTokenService],
})
export class AuthModule {}
