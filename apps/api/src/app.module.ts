import { Module } from "@nestjs/common";
import { BudgetModule } from "./budget/budget.module";
import { ExecutionsModule } from "./executions/executions.module";
import { SecretsModule } from "./secrets/secrets.module";
import { UsageModule } from "./usage/usage.module";
import { WebhooksModule } from "./webhooks/webhooks.module";

@Module({
  imports: [
    ExecutionsModule,
    SecretsModule,
    UsageModule,
    BudgetModule,
    WebhooksModule,
  ],
})
export class AppModule {}
