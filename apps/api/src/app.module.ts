import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module";
import { BudgetModule } from "./budget/budget.module";
import { ConnectionsModule } from "./connections/connections.module";
import { ExecutionsModule } from "./executions/executions.module";
import { SecretsModule } from "./secrets/secrets.module";
import { UsageModule } from "./usage/usage.module";
import { WebhooksModule } from "./webhooks/webhooks.module";

@Module({
  imports: [
    // Baseline rate limit (Sec#5): 120 requests / minute / IP across the API,
    // protecting credential-save / execution-start / oauth / hooks from abuse.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    AuthModule,
    ExecutionsModule,
    SecretsModule,
    UsageModule,
    BudgetModule,
    WebhooksModule,
    ConnectionsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
