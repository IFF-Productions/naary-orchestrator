import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module";
import { DbLifecycleService } from "./common/db-lifecycle.service";
import { BudgetModule } from "./budget/budget.module";
import { ConnectionsModule } from "./connections/connections.module";
import { ExecutionsModule } from "./executions/executions.module";
import { GraphsModule } from "./graphs/graphs.module";
import { HealthModule } from "./health/health.module";
import { MembersModule } from "./members/members.module";
import { SecretsModule } from "./secrets/secrets.module";
import { SettingsModule } from "./settings/settings.module";
import { UsageModule } from "./usage/usage.module";
import { WebhooksModule } from "./webhooks/webhooks.module";

@Module({
  imports: [
    // Baseline rate limit (Sec#5): 120 requests / minute / IP across the API,
    // protecting credential-save / execution-start / oauth / hooks from abuse.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    AuthModule,
    HealthModule,
    GraphsModule,
    ExecutionsModule,
    SecretsModule,
    UsageModule,
    BudgetModule,
    WebhooksModule,
    ConnectionsModule,
    MembersModule,
    SettingsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    DbLifecycleService,
  ],
})
export class AppModule {}
