import { Module } from "@nestjs/common";
import { ExecutionsController } from "./executions.controller";
import { ExecutionsService } from "./executions.service";

@Module({
  controllers: [ExecutionsController],
  providers: [ExecutionsService],
  exports: [ExecutionsService], // the webhook ingress reuses it to start runs
})
export class ExecutionsModule {}
