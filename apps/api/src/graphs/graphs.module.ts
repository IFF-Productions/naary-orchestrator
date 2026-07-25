import { Global, Module } from "@nestjs/common";
import { ConnectionService } from "@naary/connections";
import { CredentialsService } from "@naary/secrets";
import { EnvironmentsModule } from "../environments/environments.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { SchedulesModule } from "../schedules/schedules.module";
import { SettingsModule } from "../settings/settings.module";
import { GraphGeneratorService } from "./graph-generator.service";
import { GraphsController } from "./graphs.controller";
import { GraphsService } from "./graphs.service";
import { WorkflowLifecycleService } from "./workflow-lifecycle.service";

/** Global so ExecutionsService and the webhook ingress can resolve graphs from DB. */
@Global()
@Module({
  // EnvironmentsModule/SchedulesModule: sync a pollTrigger graph's interval schedule on save.
  // NotificationsModule: promote announces to the target env's channels (Slice 4).
  // SettingsModule: GuardrailsService reads the workspace agent-guardrail policy for the save
  // gate (#576). Import (not a re-provide) so there is ONE reader of that policy row.
  imports: [
    EnvironmentsModule,
    SchedulesModule,
    NotificationsModule,
    SettingsModule,
  ],
  controllers: [GraphsController],
  providers: [
    GraphsService,
    WorkflowLifecycleService,
    GraphGeneratorService,
    // Plain class from @naary/secrets (reads ENCRYPTION_KEY at construction); the
    // generator decrypts the tenant's provider key in-request for the model call.
    { provide: CredentialsService, useFactory: () => new CredentialsService() },
    // The generator lists the tenant's connections so it uses real connectionIds.
    { provide: ConnectionService, useFactory: () => new ConnectionService() },
  ],
  exports: [GraphsService, WorkflowLifecycleService, GraphGeneratorService],
})
export class GraphsModule {}
