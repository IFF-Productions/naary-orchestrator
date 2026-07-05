import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { type Role, ROLE_RANK, ROLES_KEY } from "./roles.decorator";
import type { RequestWithPrincipal } from "./tenant.decorator";

/**
 * RBAC gate for destructive routes (design §5). Reads the `@Roles(min)` requirement and
 * enforces `principal.role >= min` in the owner > admin > member hierarchy. The role was
 * already resolved by the AuthGuard from the MembershipCache (no extra read); an `nry_`
 * API token carries role "owner" and so passes every gate (full-access service token).
 *
 * Applied per-controller via `@UseGuards(RolesGuard)`, so it always runs AFTER the global
 * AuthGuard. A route with no `@Roles` is allowed (member+ default) — but this guard is only
 * mounted on controllers that gate, so it never sees `@UserScoped` routes.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required) return true; // no role requirement on this route

    const req = ctx.switchToHttp().getRequest<RequestWithPrincipal>();
    const role = req.principal?.role as Role | undefined;
    if (!role || ROLE_RANK[role] === undefined) {
      throw new ForbiddenException("No role in this workspace");
    }
    if (ROLE_RANK[role] < ROLE_RANK[required]) {
      throw new ForbiddenException(`Requires ${required} role or higher`);
    }
    return true;
  }
}
