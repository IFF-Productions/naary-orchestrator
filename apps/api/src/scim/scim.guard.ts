import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  createParamDecorator,
} from "@nestjs/common";
import { ScimConnectionService } from "./scim-connection.service";
import { ScimError } from "./scim.errors";

/**
 * Everything a WRITE handler is allowed to know about its caller (#1075 slice 2).
 *
 * All three fields come from the verified `ScimConnection` row and none from the request:
 * `tenantId` is the only workspace this connection may touch, `allowedEmailDomains` is the §5
 * invariant a provisioning write must satisfy, and `connectionId` is what the AuditEvent names
 * as the actor — a de-provision with no human behind it must still say WHICH connection did it.
 */
export interface ScimWriteContext {
  connectionId: string;
  tenantId: string;
  allowedEmailDomains: string[];
}

/** What the guard attaches. Note the absence of `principal` — see the guard docstring. */
export interface ScimRequest {
  headers?: Record<string, string | string[] | undefined>;
  scim?: ScimWriteContext;
}

/**
 * Authenticates a SCIM request and resolves the ONE workspace it may act in (#1075).
 *
 * WHY A SEPARATE GUARD, and why it never sets `req.principal`. The global `AuthGuard`
 * converts a credential into a principal with a role — a verified `nry_` token becomes
 * `role: "owner"` over its whole tenant. A SCIM connection is a third party's IdP, not a
 * workspace operator: it must be able to name a tenant without acquiring any authority in
 * it. So the controller is `@Public()` (the global guard returns before doing anything) and
 * this guard runs after it, attaching `req.scim` and nothing else. Every route on this
 * surface takes its tenant from `req.scim.tenantId`, so there is no code path on which a
 * SCIM bearer can reach a controller that reads `req.principal`.
 *
 * FAILS CLOSED: no bearer, wrong prefix, unknown hash, or a disabled connection ⇒ 401 in the
 * SCIM error envelope. The 401 is identical in all four cases — distinguishing them would
 * tell an unauthenticated caller which tokens exist.
 */
@Injectable()
export class ScimGuard implements CanActivate {
  constructor(private readonly connections: ScimConnectionService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<ScimRequest>();
    const header = req.headers?.authorization;
    const raw = Array.isArray(header) ? header[0] : header;
    const token =
      raw && raw.startsWith("Bearer ") ? raw.slice(7).trim() : undefined;
    if (!token) throw ScimError.unauthorized();

    const verified = await this.connections.verify(token);
    if (!verified) throw ScimError.unauthorized();

    req.scim = {
      connectionId: verified.connectionId,
      tenantId: verified.tenantId,
      allowedEmailDomains: verified.allowedEmailDomains,
    };
    return true;
  }
}

/**
 * The tenant a SCIM request may act in — read ONLY from the verified connection row.
 *
 * There is deliberately no fallback to a path segment, an `X-Workspace-Id` header or a body
 * field. A request cannot name its own tenant; if this decorator ever throws, that means the
 * guard did not run, and answering with some other tenant id would be strictly worse than a
 * 500.
 */
export const ScimTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<ScimRequest>();
    const tenantId = req.scim?.tenantId;
    if (!tenantId) throw ScimError.unauthorized();
    return tenantId;
  },
);

/**
 * The whole verified connection, for the WRITE handlers (#1075 slice 2).
 *
 * Reads need only the tenant; a write also needs the domain allowlist it must satisfy and the
 * connection id it will be audited under. Same rule as {@link ScimTenant}: everything here
 * comes from the token's own row, there is no fallback to anything the request said, and a
 * missing `req.scim` is a 401 rather than a guessed default.
 */
export const ScimConnectionCtx = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ScimWriteContext => {
    const req = ctx.switchToHttp().getRequest<ScimRequest>();
    const scim = req.scim;
    if (!scim?.tenantId || !scim.connectionId) throw ScimError.unauthorized();
    return scim;
  },
);
