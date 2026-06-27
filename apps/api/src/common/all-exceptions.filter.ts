import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { type Logger, createLogger } from "@naary/logging";
import { captureError } from "@naary/observability";

interface Res {
  status(code: number): Res;
  json(body: unknown): void;
}
interface Req {
  method?: string;
  url?: string;
  id?: string;
  principal?: { tenantId?: string };
}

/**
 * Global exception filter (Sec#11). Nest `HttpException`s carry our own safe
 * messages (validation 400, auth 401/403, not-found 404) and pass through with
 * their status. Any OTHER error is unexpected: we never leak its message/stack
 * (a DB or provider error can embed secrets) — log only the route server-side
 * and return a generic 500.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger: Logger = createLogger({ component: "api" });

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Res>();
    const req = ctx.getRequest<Req>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res
        .status(status)
        .json(
          typeof body === "string"
            ? { statusCode: status, message: body }
            : body,
        );
      return;
    }

    // Unexpected: do not serialize the error (no stack, no secret-bearing text).
    // Report to Sentry (scrubbed) with the tenant tag for triage; log the route.
    // The logger scrubs its args, so the error message is safe to attach for
    // local triage (Sentry isn't always on); requestId ties it to the access log.
    this.logger.error(
      {
        requestId: req?.id,
        tenantId: req?.principal?.tenantId,
        method: req?.method,
        path: req?.url,
        err: exception instanceof Error ? exception.message : String(exception),
      },
      "unhandled error",
    );
    captureError(exception, {
      tenantId: req?.principal?.tenantId,
      where: `${req?.method} ${req?.url}`,
    });
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ statusCode: 500, message: "Internal server error" });
  }
}
