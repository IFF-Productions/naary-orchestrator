import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { AuthModule } from "../src/auth/auth.module";
import { MembershipModule } from "../src/membership/membership.module";
import { MembershipService } from "../src/membership/membership.service";

// The guard rewrite added a MembershipService dependency to AuthGuard, which Nest must
// resolve across the @Global MembershipModule boundary. AuthGuard is registered as an
// eager APP_GUARD enhancer, so if that cross-module dependency did NOT resolve, `.compile()`
// throws "Nest can't resolve dependencies of AuthGuard (…, ?)". A unit test constructing the
// guard by hand cannot catch this; compiling the real modules can.
describe("AuthGuard DI wiring", () => {
  it("compiles AuthModule with the guard's MembershipService dependency resolved", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MembershipModule, AuthModule],
    }).compile();

    // Reaching here means the eager APP_GUARD (AuthGuard) instantiated — all four deps,
    // including the globally-provided MembershipService, resolved.
    expect(moduleRef.get(MembershipService, { strict: false })).toBeInstanceOf(
      MembershipService,
    );
  });
});
