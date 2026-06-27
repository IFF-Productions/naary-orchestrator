import "./env"; // MUST be first — loads + validates .env before @naary/* modules evaluate
import "reflect-metadata";
import { initSentry } from "@naary/observability";

// Init Sentry before anything else so early errors are captured. No-op unless
// SENTRY_DSN is set; events are scrubbed of secrets (see @naary/observability).
initSentry({ component: "api" });

import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/all-exceptions.filter";

/** Browser origins allowed to call the API (the web app). Comma-separated env,
 *  defaults to the Vite dev server. */
function corsOrigins(): string[] {
  return (process.env.CORS_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

async function bootstrap(): Promise<void> {
  // rawBody: true exposes req.rawBody (Buffer) for webhook HMAC verification,
  // alongside normal JSON parsing — so existing JSON endpoints keep working.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Security headers (Sec#5). API serves JSON only, so the helmet defaults are fine.
  app.use(helmet());

  // Explicit CORS allowlist (Sec#5): the web app calls the API cross-origin in a
  // deployed env; bearer auth means we allow the Authorization header.
  app.enableCors({
    origin: corsOrigins(),
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

  // Lets onModuleDestroy run (closes the Temporal connection + pg pool) on SIGINT/SIGTERM.
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`[api] listening on http://localhost:${port}`);
}

void bootstrap();
