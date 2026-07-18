import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { AuthModule } from "../src/auth/auth.module";
import { MembershipModule } from "../src/membership/membership.module";
import { MembershipService } from "../src/membership/membership.service";
import { PermissionsModule } from "../src/permissions/permissions.module";
import { PermissionsService } from "../src/permissions/permissions.service";

// The guard rewrite added MembershipService (and, in RBAC G1, PermissionsService — the §4a
// restricted-token stamping) as dependencies of AuthGuard, which Nest must resolve across
// the @Global module boundaries. AuthGuard is registered as an eager APP_GUARD enhancer, so
// if a cross-module dependency did NOT resolve, `.compile()` throws "Nest can't resolve
// dependencies of AuthGuard (…, ?)". A unit test constructing the guard by hand cannot
// catch this; compiling the real modules can.
describe("AuthGuard DI wiring", () => {
  it("compiles AuthModule with the guard's Membership + Permissions dependencies resolved", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MembershipModule, PermissionsModule, AuthModule],
    }).compile();

    // Reaching here means the eager APP_GUARD (AuthGuard) instantiated — all five deps,
    // including the globally-provided Membership + Permissions services, resolved.
    expect(moduleRef.get(MembershipService, { strict: false })).toBeInstanceOf(
      MembershipService,
    );
    expect(moduleRef.get(PermissionsService, { strict: false })).toBeInstanceOf(
      PermissionsService,
    );
  });
});
