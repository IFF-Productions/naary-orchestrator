import { Module } from "@nestjs/common";
import { MembersController } from "./members.controller";

/**
 * Team member management. Operates on the authoritative Membership table via the @Global
 * MembershipModule (which provides MembershipService), so no local providers are needed.
 */
@Module({
  controllers: [MembersController],
})
export class MembersModule {}
