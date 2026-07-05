import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { DbLifecycleService } from "./common/db-lifecycle.service";
import { MetricsController } from "./common/metrics.controller";
import { RequestLoggerMiddleware } from "./common/request-logger.middleware";
import { BudgetModule } from "./budget/budget.module";
import { ConnectionsModule } from "./connections/connections.module";
import { ExecutionsModule } from "./executions/executions.module";
import { GraphsModule } from "./graphs/graphs.module";
import { HealthModule } from "./health/health.module";
import { MembersModule } from "./members/members.module";
import { NotificationsModule } from "./notifications/notifications.module";
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
    AuditModule,
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
    NotificationsModule,
    TemplatesModule,
    SchedulesModule,
  ],
  controllers: [MetricsController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    DbLifecycleService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Log + meter every request (with a correlation id) — except the health probe
    // and the metrics scrape, which are hit constantly (flood the log / self-count).
    consumer
      .apply(RequestLoggerMiddleware)
      .exclude("healthz", "metrics")
      .forRoutes("*");
  }
}
