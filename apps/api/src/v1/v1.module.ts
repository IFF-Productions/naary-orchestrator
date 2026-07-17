import { Module } from "@nestjs/common";
import { EnvironmentsModule } from "../environments/environments.module";
import { ExecutionsModule } from "../executions/executions.module";
import { ApiTokenThrottlerGuard } from "./api-token-throttler.guard";
import { V1RunsController } from "./v1-runs.controller";

/**
 * The public, versioned API surface (/api/v1). A CURATED module (design §5, Option B): thin
 * controllers over the SAME services the SPA uses, with a v1-OWNED DTO layer so the public contract
 * is stable independently of internal churn. Auth is the existing global AuthGuard (nry_ tokens);
 * rate limiting is per-token via ApiTokenThrottlerGuard, additive to the global per-IP throttler.
 *
 * Slice 1: runs (start + read paths). Later slices add cancel/rerun/approve, workflows CRUD,
 * config, and the CLI — each extending this module.
 */
@Module({
  imports: [ExecutionsModule, EnvironmentsModule],
  controllers: [V1RunsController],
  providers: [ApiTokenThrottlerGuard],
})
export class V1Module {}
