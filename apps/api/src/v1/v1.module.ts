import { Module } from "@nestjs/common";
import { EnvSecretsModule } from "../env-secrets/env-secrets.module";
import { EnvironmentsModule } from "../environments/environments.module";
import { ExecutionsModule } from "../executions/executions.module";
import { UsageModule } from "../usage/usage.module";
import { VariablesModule } from "../variables/variables.module";
import { ApiTokenThrottlerGuard } from "./api-token-throttler.guard";
import { V1ConfigController } from "./v1-config.controller";
import { V1RunsController } from "./v1-runs.controller";
import { V1WorkflowsController } from "./v1-workflows.controller";

/**
 * The public, versioned API surface (/api/v1). A CURATED module (design §5, Option B): thin
 * controllers over the SAME services the SPA uses, with a v1-OWNED DTO layer so the public contract
 * is stable independently of internal churn. Auth is the existing global AuthGuard (nry_ tokens);
 * rate limiting is per-token via ApiTokenThrottlerGuard, additive to the global per-IP throttler.
 *
 * Slice 1: runs (start + read paths). Slice 2: run lifecycle (cancel/rerun/approve + awaiting).
 * Slice 3: workflows (CRUD + export/import + promote). Slice 4: config (variables + write-only
 * secrets + usage). Later slices add the CLI.
 * (GraphsService + WorkflowLifecycleService are @Global via GraphsModule — the lifecycle service is
 * the consolidated save/delete path owning the default-env schedule sync/teardown.
 * Variables/EnvSecrets/Usage modules are imported so the config controller can reuse the SAME
 * services the SPA uses — they export those providers additively for v1.)
 */
@Module({
  imports: [
    ExecutionsModule,
    EnvironmentsModule,
    VariablesModule,
    EnvSecretsModule,
    UsageModule,
  ],
  controllers: [V1RunsController, V1WorkflowsController, V1ConfigController],
  providers: [ApiTokenThrottlerGuard],
})
export class V1Module {}
