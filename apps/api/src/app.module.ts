import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuthModule } from "./auth/auth.module";
import { DbLifecycleService } from "./common/db-lifecycle.service";
import { RequestLoggerMiddleware } from "./common/request-logger.middleware";
import { BudgetModule } from "./budget/budget.module";
import { ConnectionsModule } from "./connections/connections.module";
import { ExecutionsModule } from "./executions/executions.module";
import { GraphsModule } from "./graphs/graphs.module";
import { HealthModule } from "./health/health.module";
import { MembersModule } from "./members/members.module";
import { SchedulesModule } from "./schedules/schedules.module";
import { SecretsModule } from "./secrets/secrets.module";
import { SettingsModule } from "./settings/settings.module";
import { TemplatesModule } from "./templates/templates.module";
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
    TemplatesModule,
    SchedulesModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    DbLifecycleService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Log every request (with a correlation id) — except the health probe, which
    // Docker/k8s hit every few seconds and would otherwise flood the log.
    consumer.apply(RequestLoggerMiddleware).exclude("healthz").forRoutes("*");
  }
}
