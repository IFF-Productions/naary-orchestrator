import { Module } from "@nestjs/common";
import { EnvironmentsModule } from "../environments/environments.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ApprovalsPublicController } from "./approvals-public.controller";
import { ExecutionsController } from "./executions.controller";
import { ExecutionsService } from "./executions.service";

@Module({
  // NotificationsModule powers the manual "Remind now" fan-out (Slice 1).
  imports: [EnvironmentsModule, NotificationsModule],
  controllers: [ExecutionsController, ApprovalsPublicController],
  providers: [ExecutionsService],
  exports: [ExecutionsService], // the webhook ingress reuses it to start runs
})
export class ExecutionsModule {}
