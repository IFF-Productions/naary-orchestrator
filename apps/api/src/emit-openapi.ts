/**
 * Standalone OpenAPI spec emitter — produces the SAME document the running API
 * serves at `/docs-json`, but WITHOUT booting the DB / Temporal / providers.
 *
 * It boots Nest in **preview mode** (`{ preview: true }`): controllers and their
 * route/@Api* decorator metadata are registered and scanned, but no provider is
 * instantiated or resolved — so nothing connects to Postgres or Temporal. That
 * makes this safe to run in CI (and offline) purely to snapshot the API surface.
 *
 * The config below is kept in lock-step with apps/api/src/main.ts's Swagger block:
 * if that DocumentBuilder changes, mirror it here (the drift check will catch a
 * stale spec, not a stale builder — keep them aligned by hand).
 *
 * Run: `pnpm --filter @naary/api gen:openapi` (see package.json).
 */
import "reflect-metadata";

// Preview mode does not instantiate providers, but importing AppModule still
// evaluates module-level code across the @naary/* graph — some of which reads
// these vars at import time. Provide throwaway values so nothing fails to load.
// These are NEVER used to connect to anything (no provider is constructed).
process.env.DATABASE_URL ??= "postgresql://stub:stub@localhost:5432/stub";
process.env.ENCRYPTION_KEY ??=
  "0000000000000000000000000000000000000000000000000000000000000000";
// Keep the emitter quiet and non-interactive.
process.env.SWAGGER_DISABLED = "0";

import { NestFactory } from "@nestjs/core";
import { SwaggerModule } from "@nestjs/swagger";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AppModule } from "./app.module";
import { buildOpenApiConfig } from "./swagger/openapi-config";

async function emit(): Promise<void> {
  // preview:true → register controllers/routes + decorator metadata WITHOUT
  // instantiating providers (no DB/Temporal connect). abortOnError:false and a
  // no-op logger keep the emit clean and non-fatal on optional-provider quirks.
  const app = await NestFactory.create(AppModule, {
    preview: true,
    abortOnError: false,
    logger: false,
  });

  // Same DocumentBuilder config the live boot path uses (main.ts) — shared so /docs-json
  // and this emitted spec can't drift on doc metadata.
  const config = buildOpenApiConfig();
  const document = SwaggerModule.createDocument(app, config);
  // Apply the bearer requirement to every operation (mirrors main.ts).
  document.security = [{ bearer: [] }];

  const pathCount = Object.keys(document.paths ?? {}).length;
  if (pathCount === 0) {
    await app.close();
    throw new Error(
      "OpenAPI document has zero paths — the controller scan produced nothing. " +
        "Preview mode may not have registered routes; check the fallback in emit-openapi.ts.",
    );
  }

  const outPath = resolve(__dirname, "..", "openapi.json");
  writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);
  await app.close();

  // eslint-disable-next-line no-console
  console.log(`Wrote ${outPath} — ${pathCount} paths.`);
}

void emit().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
