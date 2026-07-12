import { Injectable, type NestMiddleware } from "@nestjs/common";
import { type Logger, createLogger, newCorrelationId } from "@naary/logging";
import { httpDuration, httpRequests } from "./metrics";

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
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      const method = req.method ?? "UNKNOWN";
      const status = String(res.statusCode);
      // Log the PATHNAME only — strip any query string. A `?token=...`/`?code=...` would
      // both leak a secret into logs and inflate log cardinality/length.
      const path = (req.originalUrl ?? req.url ?? "").split("?")[0];
      const durationMs = Math.round(elapsedMs * 100) / 100;
      // Low-cardinality labels only (method + status) — never the path (ids).
      httpRequests.inc({ method, status });
      httpDuration.observe({ method, status }, elapsedMs / 1000);
      this.logger.info(
        {
          requestId,
          method, // the computed value (req.method is optional; avoid logging undefined)
          path,
          statusCode: res.statusCode,
          durationMs,
          tenantId: req.principal?.tenantId,
        },
        // A descriptive message (not a bare "request") so it reads meaningfully in a log
        // search / Sentry Logs, e.g. "POST /hooks/abc -> 202 (15.3ms)". Fields stay for filtering.
        `${method} ${path} -> ${status} (${durationMs}ms)`,
      );
    });

    next();
  }
}
