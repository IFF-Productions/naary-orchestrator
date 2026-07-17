import { Module } from "@nestjs/common";
import { EnvironmentsModule } from "../environments/environments.module";
import { ExecutionsModule } from "../executions/executions.module";
import { SchedulesModule } from "../schedules/schedules.module";
import { ApiTokenThrottlerGuard } from "./api-token-throttler.guard";
import { V1RunsController } from "./v1-runs.controller";
import { V1WorkflowsController } from "./v1-workflows.controller";

/**
 * The public, versioned API surface (/api/v1). A CURATED module (design §5, Option B): thin
 * controllers over the SAME services the SPA uses, with a v1-OWNED DTO layer so the public contract
 * is stable independently of internal churn. Auth is the existing global AuthGuard (nry_ tokens);
 * rate limiting is per-token via ApiTokenThrottlerGuard, additive to the global per-IP throttler.
 *
 * Slice 1: runs (start + read paths). Slice 2: run lifecycle (cancel/rerun/approve + awaiting).
 * Slice 3: workflows (CRUD + export/import + promote). Later slices add config and the CLI.
 * (GraphsService is @Global; SchedulesModule is imported for the workflows controller's default-env
 * schedule sync/teardown.)
 */
@Module({
  imports: [ExecutionsModule, EnvironmentsModule, SchedulesModule],
  controllers: [V1RunsController, V1WorkflowsController],
  providers: [ApiTokenThrottlerGuard],
})
export class V1Module {}
