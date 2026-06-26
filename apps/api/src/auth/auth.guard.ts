import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiTokenService } from "./api-token.service";
import { IS_PUBLIC_KEY } from "./public.decorator";
import type { Principal, RequestWithPrincipal } from "./tenant.decorator";

interface GuardRequest extends RequestWithPrincipal {
  headers: Record<string, string | undefined>;
  params?: Record<string, string>;
  path?: string;
}

/**
 * Global bearer-token guard. Authenticates `Authorization: Bearer <token>` to a
 * tenant, attaches `req.principal`, and — for tenant-scoped routes mounted under
 * `/tenants/:id/...` — enforces that the path tenant equals the authenticated
 * tenant (403 on mismatch). Routes marked `@Public()` (webhook HMAC ingress, the
 * public OAuth redirect) are skipped.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly tokens: ApiTokenService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<GuardRequest>();
    const header = req.headers?.authorization;
    const token =
      header && header.startsWith("Bearer ")
        ? header.slice(7).trim()
        : undefined;
    if (!token) throw new UnauthorizedException("Missing bearer token");

    const tenantId = await this.tokens.verify(token);
    if (!tenantId) throw new UnauthorizedException("Invalid API token");

    const principal: Principal = { tenantId };
    req.principal = principal;

    // Tenant-scoped controllers are mounted under /tenants/:id/... — the path tenant
    // must match the token's tenant. (executions/:id is scoped separately, by the
    // Execution ownership record, since its :id is a workflowId, not a tenant.)
    const path = req.path ?? "";
    const pathTenant = req.params?.id;
    if (path.startsWith("/tenants/") && pathTenant && pathTenant !== tenantId) {
      throw new ForbiddenException("Tenant mismatch");
    }
    return true;
  }
}
