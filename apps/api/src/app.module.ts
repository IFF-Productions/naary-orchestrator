import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { DbLifecycleService } from "./common/db-lifecycle.service";
import { EmbedOriginsModule } from "./common/embed-origins.module";
import { MetricsController } from "./common/metrics.controller";
import { RequestLoggerMiddleware } from "./common/request-logger.middleware";
import { BudgetModule } from "./budget/budget.module";
import { ConnectionsModule } from "./connections/connections.module";
import { ExecutionsModule } from "./executions/executions.module";
import { ChatModule } from "./chat/chat.module";
import { FormsModule } from "./forms/forms.module";
import { GraphsModule } from "./graphs/graphs.module";
import { HealModule } from "./heal/heal.module";
import { HealthModule } from "./health/health.module";
import { McpModule } from "./mcp/mcp.module";
import { McpRegistryModule } from "./mcp-registry/mcp-registry.module";
import { MembersModule } from "./members/members.module";
import { V1Module } from "./v1/v1.module";
import { WorkersModule } from "./workers/workers.module";
import { BuilderModule } from "./builder/builder.module";
import { MembershipModule } from "./membership/membership.module";
import { CompaniesModule } from "./companies/companies.module";
import { VariablesModule } from "./variables/variables.module";
import { ContentTemplatesModule } from "./content-templates/content-templates.module";
import { EnvSecretsModule } from "./env-secrets/env-secrets.module";
import { ClientIpThrottlerGuard } from "./throttle/client-ip-throttler.guard";
import {
  PUBLIC_ENDPOINT_LIMIT,
  PUBLIC_ENDPOINT_TTL_MS,
  publicEndpointTracker,
  skipUnlessPublicSubmit,
} from "./throttle/public-endpoint-throttler";
import { TurnstileConfigModule } from "./turnstile/turnstile-config.module";
import { IntrospectModule } from "./introspect/introspect.module";
import { EnvironmentsModule } from "./environments/environments.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { PermissionsModule } from "./permissions/permissions.module";
import { EvalsModule } from "./evals/evals.module";
import { PinsModule } from "./pins/pins.module";
import { SchedulesModule } from "./schedules/schedules.module";
import { TagsModule } from "./tags/tags.module";
import { SecretsModule } from "./secrets/secrets.module";
import { ScimModule } from "./scim/scim.module";
import { SsoModule } from "./sso/sso.module";
import { PreferencesModule } from "./preferences/preferences.module";
import { SettingsModule } from "./settings/settings.module";
import { TemplatesModule } from "./templates/templates.module";
import { UsageModule } from "./usage/usage.module";
import { WebhooksModule } from "./webhooks/webhooks.module";

@Module({
  imports: [
    // Two rate-limit dimensions (see the two throttle/ guards + helpers):
    //  - `default`: 120 req/min per CLIENT IP across the API (keyed by ClientIpThrottlerGuard behind
    //    nginx/cloudflared, #618) — protects credential-save / execution-start / oauth / hooks.
    //  - `public-endpoint`: caps a single public form/chat's total submit rate PER ENDPOINT, across
    //    all IPs (#616) — bounds a distributed flood the per-IP limit can't. Its own getTracker/skipIf
    //    apply it ONLY to `POST /forms/:formId` + `POST /chat/:chatId`.
    ThrottlerModule.forRoot([
      { name: "default", ttl: 60_000, limit: 120 },
      {
        name: "public-endpoint",
        ttl: PUBLIC_ENDPOINT_TTL_MS,
        limit: PUBLIC_ENDPOINT_LIMIT,
        getTracker: publicEndpointTracker,
        skipIf: skipUnlessPublicSubmit,
      },
    ]),
    AuthModule,
    PermissionsModule,
    AuditModule,
    HealthModule,
    GraphsModule,
    // Self-healing (Phase 2). Also hosts the API's Temporal worker for the heal queue.
    HealModule,
    PinsModule,
    EvalsModule,
    ExecutionsModule,
    SecretsModule,
    // SAML SSO (#455). @Global: AuthGuard (an eager APP_GUARD) verifies `nrys_` sessions with
    // SsoSessionService, and AuthModule has no imports of its own.
    SsoModule,
    ScimModule, // SCIM 2.0 directory read surface (#1075); inert with no connections registered

    UsageModule,
    BudgetModule,
    WebhooksModule,
    FormsModule,
    ChatModule,
    ConnectionsModule,
    MembersModule,
    MembershipModule,
    CompaniesModule,
    VariablesModule,
    ContentTemplatesModule,
    EnvSecretsModule,
    TurnstileConfigModule,
    EmbedOriginsModule, // @Global: the per-tenant embed-origin resolver behind public CORS (#617)
    IntrospectModule,
    SettingsModule,
    PreferencesModule,
    EnvironmentsModule,
    NotificationsModule,
    TagsModule,
    TemplatesModule,
    SchedulesModule,
    McpModule,
    McpRegistryModule,
    V1Module,
    WorkersModule,
    BuilderModule,
  ],
  controllers: [MetricsController],
  providers: [
    // Key rate limits on the REAL client IP (behind nginx/cloudflared), not the proxy's — else the
    // global limiter + per-route @Throttle on public form/chat collapse into one bucket (#596).
    { provide: APP_GUARD, useClass: ClientIpThrottlerGuard },
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
