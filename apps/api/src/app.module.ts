import { Module } from "@nestjs/common";
import { ExecutionsModule } from "./executions/executions.module";
import { SecretsModule } from "./secrets/secrets.module";
import { UsageModule } from "./usage/usage.module";

@Module({
  imports: [ExecutionsModule, SecretsModule, UsageModule],
})
export class AppModule {}
