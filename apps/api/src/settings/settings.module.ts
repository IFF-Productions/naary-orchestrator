import { Module } from "@nestjs/common";
import { GuardrailsService } from "./guardrails.service";
import { SettingsController } from "./settings.controller";
import { SettingsService } from "./settings.service";

@Module({
  controllers: [SettingsController],
  // GuardrailsService is EXPORTED so GraphsModule can inject it for the save gate (#576 AC1) —
  // one reader of the policy row, not two divergent copies of the query.
  providers: [SettingsService, GuardrailsService],
  exports: [GuardrailsService],
})
export class SettingsModule {}
