import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { MembersModule } from "../src/members/members.module";
import { MembershipModule } from "../src/membership/membership.module";
import { PermissionsModule } from "../src/permissions/permissions.module";
import { MembersService } from "../src/members/members.service";

/**
 * MembersModule declares only [MembersService, MailerService], so MembersService's other
 * dependencies — MembershipService and, since #1041, PermissionsService — arrive from @Global
 * modules with no import line to notice if one goes away. An unresolvable provider is a
 * boot-time failure that 500s every route, and the unit specs construct the service by hand,
 * so they cannot see it. Same posture as auth-guard-di / connections-di / secrets-module-di.
 */
describe("MembersService DI", () => {
  it("resolves PermissionsService from the @Global PermissionsModule", async () => {
    const ref = await Test.createTestingModule({
      imports: [PermissionsModule, MembershipModule, MembersModule],
    }).compile();
    expect(ref.get(MembersService)).toBeInstanceOf(MembersService);
  });
});
