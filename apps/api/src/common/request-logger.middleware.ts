import { Injectable, type NestMiddleware } from "@nestjs/common";
import { type Logger, createLogger, newCorrelationId } from "@naary/logging";

/** Minimal shapes — avoids a hard dependency on the express types here. */
interface Req {
  method?: string;
  url?: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  id?: string;
  principal?: { tenantId?: string };
}
interface Res {
  statusCode: number;
  setHeader(name: string, value: string): void;
  on(event: "finish", cb: () => void): void;
}

/**
 * Assigns a correlation id to every request and logs one structured line when the
 * response finishes — method, path, status, duration, and (once the auth guard has
 * run) the tenant. The id is echoed back as `x-request-id` so a client/log line
 * can be tied to a single run. Runs before the guard, but reads `req.principal`
 * lazily at finish-time, by which point the guard has populated it.
 */
@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger: Logger = createLogger({ component: "api" });

  use(req: Req, res: Res, next: () => void): void {
    const incoming = req.headers["x-request-id"];
    const requestId =
      (typeof incoming === "string" && incoming) || newCorrelationId();
    req.id = requestId;
    res.setHeader("x-request-id", requestId);

    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs =
        Math.round(Number(process.hrtime.bigint() - start) / 1e4) / 100;
      this.logger.info(
        {
          requestId,
          method: req.method,
          path: req.originalUrl ?? req.url,
          statusCode: res.statusCode,
          durationMs,
          tenantId: req.principal?.tenantId,
        },
        "request",
      );
    });

    next();
  }
}
