import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { tap } from "rxjs/operators";
import { actionFor, AuditService } from "./audit.service";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface Req {
  method: string;
  path?: string;
  url?: string;
  principal?: { tenantId: string; subject?: string };
}

/**
 * Records one AuditEvent per SUCCESSFUL mutating request (POST/PUT/PATCH/DELETE),
 * globally — so "who did what, when" is captured without touching each controller.
 * Reads (GET) and the audit endpoint itself are skipped. Fire-and-forget after the
 * response resolves: the write is best-effort and never blocks or fails the request.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Req>();
    const path = (req.path ?? req.url ?? "").split("?")[0];

    const shouldLog =
      MUTATING.has(req.method) &&
      !!req.principal &&
      // don't audit reads of the audit log (there are none), keep it self-quiet
      !/\/audit$/.test(path);

    return next.handle().pipe(
      tap(() => {
        if (!shouldLog || !req.principal) return;
        const res = ctx.switchToHttp().getResponse<{ statusCode?: number }>();
        // Fire-and-forget: don't await inside the response path.
        void this.audit.record({
          tenantId: req.principal.tenantId,
          actor: req.principal.subject ?? "api-token",
          action: actionFor(req.method, path),
          method: req.method,
          path,
          statusCode: res?.statusCode ?? 200,
        });
      }),
    );
  }
}
