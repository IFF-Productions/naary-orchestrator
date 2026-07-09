import { Module } from "@nestjs/common";
import { WorkflowActivationController } from "./activation.controller";
import { SchedulesController } from "./schedules.controller";
import { SchedulesService } from "./schedules.service";

@Module({
  controllers: [SchedulesController, WorkflowActivationController],
  providers: [SchedulesService],
  exports: [SchedulesService], // GraphsModule uses it to sync pollTrigger schedules
})
export class SchedulesModule {}
