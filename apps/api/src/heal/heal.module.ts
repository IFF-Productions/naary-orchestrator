/**
 * Self-healing (Phase 2).
 *
 * Also the module that OWNS the API's Temporal worker for the heal task queue — see heal-worker.ts
 * for why the activities live in this process rather than in the main worker. The worker starts in
 * `HealService.onModuleInit` and is fail-soft: if it cannot start, proposals stop being generated
 * and every other route keeps serving.
 */
import { Module } from "@nestjs/common";
import { EnvironmentsModule } from "../environments/environments.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { HealController } from "./heal.controller";
import { HealService } from "./heal.service";

@Module({
  imports: [EnvironmentsModule, NotificationsModule],
  controllers: [HealController],
  providers: [HealService],
  exports: [HealService],
})
export class HealModule {}
