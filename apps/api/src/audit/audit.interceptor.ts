import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { tap } from "rxjs/operators";
import { EnvironmentsService } from "../environments/environments.service";
import { actionFor, AuditService } from "./audit.service";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface Req {
  method: string;
  path?: string;
  url?: string;
  principal?: { tenantId: string; subject?: string; environmentSel?: string };
}

/**
 * Records one AuditEvent per SUCCESSFUL mutating request (POST/PUT/PATCH/DELETE),
 * globally — so "who did what, when" is captured without touching each controller.
 * Reads (GET) and the audit endpoint itself are skipped. Fire-and-forget after the
 * response resolves: the write is best-effort and never blocks or fails the request.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly audit: AuditService,
    private readonly environments: EnvironmentsService,
  ) {}

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
        const principal = req.principal;
        const res = ctx.switchToHttp().getResponse<{ statusCode?: number }>();
        // Fire-and-forget: don't await inside the response path. Resolve the actor's selected env
        // to a canonical id (slug from the SPA / uuid from a bound token both normalize via
        // resolveEnvId); a stale/unknown selection degrades to null — never surface it (this tap
        // fires on non-env-scoped routes too, where no controller validated the header).
        void (async () => {
          const environmentId = principal.environmentSel
            ? await this.environments
                .resolveEnvId(principal.tenantId, principal.environmentSel)
                .catch(() => null)
            : null;
          await this.audit.record({
            tenantId: principal.tenantId,
            actor: principal.subject ?? "api-token",
            action: actionFor(req.method, path),
            method: req.method,
            path,
            statusCode: res?.statusCode ?? 200,
            environmentId,
          });
        })();
      }),
    );
  }
}
