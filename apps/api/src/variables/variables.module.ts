import { Module } from "@nestjs/common";
import { EnvironmentsModule } from "../environments/environments.module";
import { VariablesController } from "./variables.controller";
import { VariablesService } from "./variables.service";

/** Global Variables ($vars) — non-secret, env-scoped workspace config for expressions. */
@Module({
  imports: [EnvironmentsModule],
  controllers: [VariablesController],
  providers: [VariablesService],
})
export class VariablesModule {}
