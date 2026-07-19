import { Module } from "@nestjs/common";
import { WorkersController } from "./workers.controller";
import { WorkersService } from "./workers.service";

/** Worker fleet registry (Queue-mode / Worker view) — a read over WorkerHeartbeat. */
@Module({
  controllers: [WorkersController],
  providers: [WorkersService],
})
export class WorkersModule {}
