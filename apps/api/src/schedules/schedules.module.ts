import { Module } from "@nestjs/common";
import { EnvironmentsModule } from "../environments/environments.module";
import { WorkflowActivationController } from "./activation.controller";
import { SchedulesController } from "./schedules.controller";
import { SchedulesService } from "./schedules.service";

@Module({
  imports: [EnvironmentsModule],
  controllers: [SchedulesController, WorkflowActivationController],
  providers: [SchedulesService],
  exports: [SchedulesService], // GraphsModule uses it to sync pollTrigger schedules
})
export class SchedulesModule {}
