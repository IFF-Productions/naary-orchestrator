import { Module } from "@nestjs/common";
import {
  AcceptInvitationController,
  InvitationsController,
} from "./invitations.controller";
import { InvitationsService } from "./invitations.service";

/**
 * Workspace invitations (design Path B). MembershipService (for accept → create membership
 * + bust cache) comes from the @Global MembershipModule, so no explicit import is needed.
 */
@Module({
  controllers: [InvitationsController, AcceptInvitationController],
  providers: [InvitationsService],
})
export class InvitationsModule {}
