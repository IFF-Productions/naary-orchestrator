import type { LoggerService } from "@nestjs/common";
import { type Logger, createLogger } from "@naary/logging";

/**
 * Adapts pino to Nest's `LoggerService` so framework logs (route mapping,
 * shutdown, etc.) come out as the same structured JSON as our own logs — instead
 * of Nest's default colorized text. Installed via `app.useLogger()` in main.ts.
 *
 * Nest calls `log/error/warn/...` with the message first and an optional context
 * string (the originating class) last; we surface that as the `context` field.
 */
export class AppLogger implements LoggerService {
  constructor(
    private readonly logger: Logger = createLogger({ component: "api" }),
  ) {}

  /** The underlying pino logger, for boot-time / non-Nest logging in main.ts. */
  get pino(): Logger {
    return this.logger;
  }

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.logger.error({ context, stack }, String(message));
  }

  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, String(message));
  }

  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }

  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, String(message));
  }
}
