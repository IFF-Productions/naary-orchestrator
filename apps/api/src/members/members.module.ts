import { Module } from "@nestjs/common";
import { ExecutionsModule } from "../executions/executions.module";
import { MailerService } from "../mail/mailer.service";
import { MembersController } from "./members.controller";
import { MembersService } from "./members.service";

@Module({
  // ExecutionsModule for the post-removal stranded-approval read (#1053): it owns the single
  // Temporal client, and this is a read of paused-run state. AuditService arrives from the
  // @Global AuditModule (members-di.spec.ts pins both).
  imports: [ExecutionsModule],
  controllers: [MembersController],
  providers: [MembersService, MailerService],
  // Exported for ScimModule (#1075 slice 2): SCIM provisioning/de-provisioning must reuse the
  // member lifecycle — invite / removeMember / revokeInvitation — rather than write Membership
  // and Invitation rows itself. Exporting it is what makes that reuse structural.
  exports: [MembersService],
})
export class MembersModule {}
