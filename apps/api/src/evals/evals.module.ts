import { Module } from "@nestjs/common";
import { EnvironmentsModule } from "../environments/environments.module";
import { EvalRunsController, EvalsController } from "./evals.controller";
import { EvalsService } from "./evals.service";

/**
 * Workflow evals (#575). GraphsModule is @Global, so `GraphsService` (which snapshots the pinned
 * graph version an eval batch measures) is injectable without importing it.
 */
@Module({
  imports: [EnvironmentsModule],
  controllers: [EvalsController, EvalRunsController],
  providers: [EvalsService],
  exports: [EvalsService],
})
export class EvalsModule {}
