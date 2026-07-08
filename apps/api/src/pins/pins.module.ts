import { Module } from "@nestjs/common";
import { ExecutionsModule } from "../executions/executions.module";
import { PinsController } from "./pins.controller";
import { PinsService } from "./pins.service";

@Module({
  imports: [ExecutionsModule], // ExecutionsService.testNode runs activity-node tests
  controllers: [PinsController],
  providers: [PinsService],
})
export class PinsModule {}
