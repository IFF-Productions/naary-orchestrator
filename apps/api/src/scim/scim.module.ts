import { Module } from "@nestjs/common";
import { MembersModule } from "../members/members.module";
import { ScimConnectionService } from "./scim-connection.service";
import { ScimProvisioningService } from "./scim-provisioning.service";
import { ScimUsersService } from "./scim-users.service";
import { ScimController } from "./scim.controller";
import { ScimGuard } from "./scim.guard";

/**
 * SCIM 2.0 provisioning (#1075 slices 1–2 — reads + create/delete).
 *
 * `MembersModule` is imported, not re-implemented: de-provisioning MUST go through
 * `MembersService` (see ScimController's docstring), so SCIM depends on the module that owns
 * member lifecycle rather than owning a second copy of it. `AuditService` arrives from the
 * @Global AuditModule.
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
  imports: [MembersModule],
  controllers: [ScimController],
  providers: [
    ScimConnectionService,
    ScimUsersService,
    ScimProvisioningService,
    ScimGuard,
  ],
  exports: [ScimConnectionService],
})
export class ScimModule {}
