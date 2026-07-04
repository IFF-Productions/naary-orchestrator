import { Module } from "@nestjs/common";
import { SchedulesController } from "./schedules.controller";
import { SchedulesService } from "./schedules.service";

@Module({
  controllers: [SchedulesController],
  providers: [SchedulesService],
  exports: [SchedulesService], // GraphsModule uses it to sync pollTrigger schedules
})
export class SchedulesModule {}
