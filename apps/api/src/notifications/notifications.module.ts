import { Module } from "@nestjs/common";
import { EnvironmentsModule } from "../environments/environments.module";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";

@Module({
  imports: [EnvironmentsModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService], // the executions "Remind now" endpoint reuses the fan-out
})
export class NotificationsModule {}
