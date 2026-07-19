import { Module } from "@nestjs/common";
import { EnvironmentsModule } from "../environments/environments.module";
import { BuilderSessionsController } from "./builder-sessions.controller";
import { BuilderSessionsService } from "./builder-sessions.service";

/** Conversational AI builder — persisted session lifecycle (Slice 1). GraphsService is available
 *  globally (GraphsModule is @Global) for seeding a draft from an existing workflow. */
@Module({
  imports: [EnvironmentsModule], // resolve the active env selector to a concrete env id
  controllers: [BuilderSessionsController],
  providers: [BuilderSessionsService],
  exports: [BuilderSessionsService], // Slice 2's stream controller reuses lifecycle methods
})
export class BuilderModule {}
