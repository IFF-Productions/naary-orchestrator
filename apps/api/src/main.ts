import "./env"; // MUST be first — loads .env before @naary/* modules evaluate
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  // rawBody: true exposes req.rawBody (Buffer) for webhook HMAC verification,
  // alongside normal JSON parsing — so existing JSON endpoints keep working.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  // Lets onModuleDestroy run (closes the Temporal connection) on SIGINT/SIGTERM.
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`[api] listening on http://localhost:${port}`);
}

void bootstrap();
