import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiTokenService } from "./api-token.service";
import { FirebaseVerifier } from "./firebase-verifier";
import { IS_PUBLIC_KEY } from "./public.decorator";
import type { Principal, RequestWithPrincipal } from "./tenant.decorator";

interface GuardRequest extends RequestWithPrincipal {
  headers: Record<string, string | undefined>;
  params?: Record<string, string>;
  path?: string;
}

/**
 * Global dual-auth guard. Authenticates `Authorization: Bearer <token>` to a
 * tenant via EITHER a Firebase ID token (human users — tenant from the `tenant`
 * custom claim) OR a per-tenant API token (`nry_…`, for services/CLI/CI), attaches
 * `req.principal`, and — for tenant-scoped routes under `/tenants/:id/...` —
 * enforces that the path tenant equals the authenticated tenant (403 on mismatch).
 * `@Public()` routes (webhook HMAC ingress, the MCP-connection OAuth redirect) are
 * skipped — note that redirect is the connections OAuth, NOT user login.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly tokens: ApiTokenService,
    private readonly firebase: FirebaseVerifier,
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

    // `nry_…` → API token (services/CLI); anything else → Firebase ID token (humans).
    let principal: Principal | undefined;
    if (token.startsWith("nry_")) {
      const tenantId = await this.tokens.verify(token);
      if (tenantId) principal = { tenantId };
    } else if (this.firebase.enabled) {
      const p = await this.firebase.verify(token);
      if (p) principal = { tenantId: p.tenantId, subject: p.subject };
    }
    if (!principal) throw new UnauthorizedException("Invalid credentials");
    req.principal = principal;

    // Tenant-scoped controllers are mounted under /tenants/:id/... — the path tenant
    // must match the token's tenant. (executions/:id is scoped separately, by the
    // Execution ownership record, since its :id is a workflowId, not a tenant.)
    const path = req.path ?? "";
    const pathTenant = req.params?.id;
    if (
      path.startsWith("/tenants/") &&
      pathTenant &&
      pathTenant !== principal.tenantId
    ) {
      throw new ForbiddenException("Tenant mismatch");
    }
    return true;
  }
}
