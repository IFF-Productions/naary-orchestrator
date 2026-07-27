import "./env"; // MUST be first — loads + validates .env before @naary/* modules evaluate
import "reflect-metadata";
import { initFlags } from "@naary/flags";
import { initMetrics } from "@naary/metrics";
import { initOtlp, initSentry } from "@naary/observability";

// Init Sentry before anything else so early errors are captured. No-op unless
// SENTRY_DSN is set; events are scrubbed of secrets (see @naary/observability).
initSentry({ component: "api" });
// Tag metrics with the component + collect default Node/process metrics.
initMetrics({ component: "api" });
// Wire the OTLP metric exporter (Datadog/OTLP). No-op unless OTEL_EXPORTER_OTLP_ENDPOINT
// is set; attributes are scrubbed on egress (see @naary/observability otlp.ts).
initOtlp({ component: "api" });
// Wire the feature-flag provider (Flagsmith). Fail-safe + non-blocking: no
// FLAGSMITH_ENVIRONMENT_KEY ⇒ code defaults; a slow/down Flagsmith never stalls boot.
initFlags();

import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { EmbedOriginsService } from "./common/embed-origins.service";
import { makePublicCors } from "./common/public-cors";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/all-exceptions.filter";
import { AppLogger } from "./common/app-logger";
import { buildOpenApiConfig } from "./swagger/openapi-config";
import { browserCorsOrigins, port as configuredPort, swaggerDisabled } from "./config";

async function bootstrap(): Promise<void> {
  // rawBody: true exposes req.rawBody (Buffer) for webhook HMAC verification,
  // alongside normal JSON parsing — so existing JSON endpoints keep working.
  // bufferLogs holds startup logs until our structured logger is installed so
  // framework logs come out as JSON too (no console-text/JSON mix).
  const appLogger = new AppLogger();
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    bufferLogs: true,
  });
  app.useLogger(appLogger);

  // Security headers (Sec#5). API serves JSON only, so the helmet defaults are fine.
  // NB (Turnstile, docs/design/TURNSTILE-BOT-PROTECTION.md): the SPA is served separately with no
  // CSP today, so nothing blocks the Cloudflare widget script. IF a SPA-side CSP is ever added, it
  // must allow `https://challenges.cloudflare.com` in `script-src` + `frame-src`.
  app.use(helmet());

  // CORS on the ANONYMOUS public embed ingress (/forms/:id, /chat/:id) BEFORE the app's allowlist
  // below — lets tenants embed a form/chat natively (their own JS). Safe: no cookies, so ACAO:*
  // leaks nothing; protection stays with Turnstile + rate limits + budget (see public-cors.ts).
  // #617: narrowed per tenant when they've configured embed domains (the shared Turnstile hostname
  // allowlist); permissive (`*`, as before) when they haven't.
  const embedOrigins = app.get(EmbedOriginsService);
  app.use(makePublicCors((path) => embedOrigins.allowedHostnamesForPath(path)));

  // Explicit CORS allowlist (Sec#5): the web app calls the API cross-origin in a
  // deployed env; bearer auth means we allow the Authorization header.
  app.enableCors({
    origin: browserCorsOrigins(),
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization"],
  });

  // Validate + strip every request body against its DTO: unknown fields are
  // rejected (forbidNonWhitelisted), missing required fields 400 (no silent
  // approve→reject), and types are coerced (transform).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Sanitize errors so internals/secrets never reach the client (Sec#11).
  app.useGlobalFilters(new AllExceptionsFilter());

  // OpenAPI / Swagger docs. Served at /docs (interactive UI) with the machine-readable
  // schema at /docs-json. Every endpoint authenticates with a Bearer token (an `nry_` API
  // token or a Firebase ID token), so we register one bearer scheme and mark it required for
  // all operations. Set SWAGGER_DISABLED=1 to omit it in a hardened deployment.
  if (!swaggerDisabled()) {
    // Shared with the standalone spec emitter (emit-openapi.ts) so /docs-json and the
    // generated web types can't drift on doc metadata.
    const config = buildOpenApiConfig();
    const document = SwaggerModule.createDocument(app, config);
    // Apply the bearer requirement to every operation (avoids decorating each controller).
    document.security = [{ bearer: [] }];
    SwaggerModule.setup("docs", app, document, {
      jsonDocumentUrl: "docs-json",
      swaggerOptions: { persistAuthorization: true },
    });
  }

  // Lets onModuleDestroy run (closes the Temporal connection + pg pool) on SIGINT/SIGTERM.
  app.enableShutdownHooks();
  const port = configuredPort();
  await app.listen(port);
  appLogger.pino.info({ port }, "api listening");
}

void bootstrap();
