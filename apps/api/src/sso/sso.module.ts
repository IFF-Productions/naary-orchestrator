import { Global, Module } from "@nestjs/common";
import { SsoConnectionsController } from "./sso-connections.controller";
import { SsoSessionService } from "./sso-session.service";
import { SsoController } from "./sso.controller";
import { SsoService } from "./sso.service";

/**
 * SAML SSO (design SAML-SSO.md, #455).
 *
 * `@Global()` for the same reason MembershipModule and PermissionsModule are: `AuthGuard` is
 * an eager `APP_GUARD` registered by `AuthModule`, which has no `imports:` — so a dependency
 * the guard needs has to be globally available or `.compile()` throws at boot. `SsoSessionService`
 * is that dependency (the guard verifies `nrys_` bearers with it).
 *
 * Everything here is inert unless configured: no `SSO_SESSION_SECRET` / `SSO_SP_ENTITY_ID` /
 * `SSO_ACS_URL` ⇒ the routes answer "not configured" and the guard's SSO branch verifies
 * nothing. A Firebase-only deployment is unaffected.
 */
@Global()
@Module({
  controllers: [SsoController, SsoConnectionsController],
  providers: [SsoSessionService, SsoService],
  exports: [SsoSessionService, SsoService],
})
export class SsoModule {}
