import { Module } from "@nestjs/common";
import { ScimConnectionService } from "./scim-connection.service";
import { ScimUsersService } from "./scim-users.service";
import { ScimController } from "./scim.controller";
import { ScimGuard } from "./scim.guard";

/**
 * SCIM 2.0 provisioning (#1075 slice 1 — READ ONLY).
 *
 * NOT `@Global()`, unlike SsoModule: nothing outside this folder depends on it, and in
 * particular the global `AuthGuard` does not — a SCIM bearer is verified by {@link ScimGuard}
 * at the controller, never by the guard that mints principals. Keeping it local is what
 * makes that structural rather than a convention.
 *
 * Inert until an operator registers a connection (`register-scim-connection.ts`): with no
 * ScimConnection rows every request to /scim/v2 is a 401, so mounting this module changes
 * nothing for a deployment that does not use SCIM.
 */
@Module({
  controllers: [ScimController],
  providers: [ScimConnectionService, ScimUsersService, ScimGuard],
  exports: [ScimConnectionService],
})
export class ScimModule {}
