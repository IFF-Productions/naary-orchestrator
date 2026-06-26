import "./env"; // MUST be first — loads .env before @naary/* modules evaluate
import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  // rawBody: true exposes req.rawBody (Buffer) for webhook HMAC verification,
  // alongside normal JSON parsing — so existing JSON endpoints keep working.
  const app = await NestFactory.create(AppModule, { rawBody: true });
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
  // Lets onModuleDestroy run (closes the Temporal connection) on SIGINT/SIGTERM.
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`[api] listening on http://localhost:${port}`);
}

void bootstrap();
