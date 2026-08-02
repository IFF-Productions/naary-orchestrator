import "reflect-metadata";
// GraphsModule (@Global, and now reachable from MembersModule via ExecutionsModule) pulls in
// ConnectionsModule, whose SecretStore reads ENCRYPTION_KEY at CONSTRUCTION — set it before the
// modules are imported/instantiated. Same preamble as connections-di / embed-origins-di.
process.env.ENCRYPTION_KEY ??= "0".repeat(64);
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { AuditModule } from "../src/audit/audit.module";
import { AuditService } from "../src/audit/audit.service";
import { ExecutionsService } from "../src/executions/executions.service";
import { GraphsModule } from "../src/graphs/graphs.module";
import { MembersModule } from "../src/members/members.module";
import { MembershipModule } from "../src/membership/membership.module";
import { PermissionsModule } from "../src/permissions/permissions.module";
import { MembersService } from "../src/members/members.service";

/**
 * MembersModule declares only [MembersService, MailerService], so MembersService's other
 * dependencies — MembershipService, PermissionsService (#1041), and AuditService (#1053) —
 * arrive from @Global modules with no import line to notice if one goes away. An unresolvable
 * provider is a boot-time failure that 500s every route, and the unit specs construct the
 * service by hand, so they cannot see it. Same posture as auth-guard-di / connections-di /
 * secrets-module-di.
 *
 * ExecutionsService (#1053) is the one that DOES come through an import line, but it drags
 * ExecutionsModule's own graph behind it — so this also pins that MembersModule → ExecutionsModule
 * stays resolvable. `.compile()` runs no lifecycle hooks, so nothing here connects to Temporal.
 */
describe("MembersService DI", () => {
  it("resolves PermissionsService, AuditService and ExecutionsService", async () => {
    const ref = await Test.createTestingModule({
      imports: [
        PermissionsModule,
        MembershipModule,
        AuditModule,
        GraphsModule,
        MembersModule,
      ],
    }).compile();
    expect(ref.get(MembersService)).toBeInstanceOf(MembersService);
    expect(ref.get(AuditService)).toBeInstanceOf(AuditService);
    expect(ref.get(ExecutionsService, { strict: false })).toBeInstanceOf(
      ExecutionsService,
    );
  });
});
