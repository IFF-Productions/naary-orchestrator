import { Module } from "@nestjs/common";
import { ApprovalsPublicController } from "./approvals-public.controller";
import { ExecutionsController } from "./executions.controller";
import { ExecutionsService } from "./executions.service";

@Module({
  controllers: [ExecutionsController, ApprovalsPublicController],
  providers: [ExecutionsService],
  exports: [ExecutionsService], // the webhook ingress reuses it to start runs
})
export class ExecutionsModule {}
