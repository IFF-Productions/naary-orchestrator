import { Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { BudgetModule } from "./budget/budget.module";
import { ConnectionsModule } from "./connections/connections.module";
import { ExecutionsModule } from "./executions/executions.module";
import { SecretsModule } from "./secrets/secrets.module";
import { UsageModule } from "./usage/usage.module";
import { WebhooksModule } from "./webhooks/webhooks.module";

@Module({
  imports: [
    AuthModule,
    ExecutionsModule,
    SecretsModule,
    UsageModule,
    BudgetModule,
    WebhooksModule,
    ConnectionsModule,
  ],
})
export class AppModule {}
