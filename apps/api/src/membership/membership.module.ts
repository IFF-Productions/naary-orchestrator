import { Global, Module } from "@nestjs/common";
import {
  InMemoryMembershipCache,
  type MembershipCache,
} from "./membership-cache";
import { MEMBERSHIP_CACHE, MembershipService } from "./membership.service";
import { WorkspacesController } from "./workspaces.controller";

/**
 * Membership foundation (design slice 1, additive part). Global so a later slice's
 * guard can inject MembershipService. The cache is in-memory today; a Redis impl slots
 * in behind the MembershipCache interface (select by REDIS_URL) for multi-instance.
 */
@Global()
@Module({
  controllers: [WorkspacesController],
  providers: [
    MembershipService,
    {
      provide: MEMBERSHIP_CACHE,
      useFactory: (): MembershipCache => new InMemoryMembershipCache(),
    },
  ],
  exports: [MembershipService],
})
export class MembershipModule {}
