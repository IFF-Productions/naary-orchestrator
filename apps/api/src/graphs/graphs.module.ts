import { Global, Module } from "@nestjs/common";
import { CredentialsService } from "@naary/secrets";
import { ConnectionsModule } from "../connections/connections.module";
import { EnvironmentsModule } from "../environments/environments.module";
import { FormAssetModule } from "../forms/form-asset.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { SchedulesModule } from "../schedules/schedules.module";
import { SettingsModule } from "../settings/settings.module";
import { GraphGeneratorService } from "./graph-generator.service";
import { GraphsController } from "./graphs.controller";
import { GraphsService } from "./graphs.service";
import { DryRunService } from "./dry-run.service";
import { WorkflowLifecycleService } from "./workflow-lifecycle.service";
import { WorkflowKeyRenameService } from "./workflow-key-rename.service";

/** Global so ExecutionsService and the webhook ingress can resolve graphs from DB. */
@Global()
@Module({
  // EnvironmentsModule/SchedulesModule: sync a pollTrigger graph's interval schedule on save.
  // NotificationsModule: promote announces to the target env's channels (Slice 4).
  // SettingsModule: GuardrailsService reads the workspace agent-guardrail policy for the save
  // gate (#576). Import (not a re-provide) so there is ONE reader of that policy row.
  // FormAssetModule: the save gate verifies a formTrigger's logoAssetId belongs to this
  // tenant+environment (cross-tenant hotlinking of an asset we host). Its own module rather than
  // FormsModule, which would be a cycle — see FormAssetModule.
  imports: [
    // ConnectionsModule: the dry run probes each connection with the SAME non-write test the
    // Integrations tab uses (#832).
    ConnectionsModule,
    EnvironmentsModule,
    SchedulesModule,
    NotificationsModule,
    SettingsModule,
    FormAssetModule,
  ],
  controllers: [GraphsController],
  providers: [
    GraphsService,
    WorkflowLifecycleService,
    WorkflowKeyRenameService,
    GraphGeneratorService,
    DryRunService,
    // Plain class from @naary/secrets (reads ENCRYPTION_KEY at construction); the
    // generator decrypts the tenant's provider key in-request for the model call.
    { provide: CredentialsService, useFactory: () => new CredentialsService() },
    // ConnectionService is NOT re-provided here: it comes from ConnectionsModule's exports (see
    // imports). Providing it locally too would give the app two instances — one behind
    // ConnectionTestService, one behind the generator — which is a latent split-brain the moment
    // that service holds any state.
  ],
  exports: [
    GraphsService,
    WorkflowLifecycleService,
    WorkflowKeyRenameService,
    GraphGeneratorService,
    DryRunService,
  ],
})
export class GraphsModule {}
