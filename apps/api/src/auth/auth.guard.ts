import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { MembershipService } from "../membership/membership.service";
import { ApiTokenService } from "./api-token.service";
import { FirebaseVerifier } from "./firebase-verifier";
import { IS_PUBLIC_KEY } from "./public.decorator";
import type { Principal, RequestWithPrincipal } from "./tenant.decorator";
import { IS_USER_SCOPED_KEY } from "./user-scoped.decorator";

interface GuardRequest extends RequestWithPrincipal {
  headers: Record<string, string | undefined>;
  params?: Record<string, string>;
  path?: string;
}

/** SPA sends the selected workspace here; the guard membership-checks it. */
const WORKSPACE_HEADER = "x-workspace-id";

/**
 * Global dual-auth guard.
 *
 * Authenticates `Authorization: Bearer <token>` as EITHER a Firebase ID token (humans —
 * authenticates the USER) OR a per-tenant `nry_` API token (services/CLI/CI — full access
 * to its single tenant), then resolves the ACTIVE workspace and attaches `req.principal`.
 *
 * The trust model (design PROVISIONING-MULTIUSER §3): the Firebase token no longer names
 * a tenant — a `Membership(userId, tenantId, role)` row is the authority. The active
 * workspace is the `/tenants/:id` path segment or the `X-Workspace-Id` header; the guard
 * verifies the user has a Membership there (403 if not — the core cross-tenant check,
 * attack #1) and loads their role from the MembershipCache. A legacy `tenant` claim is a
 * transitional owner grant, lazily migrated to a Membership.
 *
 * Fails CLOSED: a workspace-scoped route with no resolvable membership → 403. Only routes
 * marked `@UserScoped()` (identity/onboarding) run tenant-less. `@Public()` routes
 * (webhook HMAC ingress, connections OAuth redirect) skip auth entirely.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly tokens: ApiTokenService,
    private readonly firebase: FirebaseVerifier,
    private readonly reflector: Reflector,
    private readonly memberships: MembershipService,
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

    // The workspace being targeted: a /tenants/:id path segment (extracted by PATTERN so a
    // global prefix can't silently disable the check — see AUTH-PROVISIONING-AUDIT P-1) or
    // the X-Workspace-Id header. If both are present they must agree.
    const pathTenant = /(?:^|\/)tenants\/([^/]+)/.exec(req.path ?? "")?.[1];
    const headerTenant = req.headers?.[WORKSPACE_HEADER]?.trim() || undefined;
    if (pathTenant && headerTenant && pathTenant !== headerTenant) {
      throw new ForbiddenException("Workspace mismatch");
    }
    const target = pathTenant ?? headerTenant;

    // `nry_…` → API token: full access to its ONE tenant, no membership model. Unchanged
    // from the claim era — this keeps the cross-tenant isolation tests green.
    if (token.startsWith("nry_")) {
      const tenantId = await this.tokens.verify(token);
      if (!tenantId) throw new UnauthorizedException("Invalid credentials");
      if (target && target !== tenantId) {
        throw new ForbiddenException("Tenant mismatch");
      }
      req.principal = { tenantId, role: "owner" };
      return true;
    }

    // Otherwise a Firebase ID token authenticates the USER.
    if (!this.firebase.enabled) {
      throw new UnauthorizedException("Invalid credentials");
    }
    const user = await this.firebase.verify(token);
    if (!user) throw new UnauthorizedException("Invalid credentials");

    // Tenants this user may reach = their memberships ∪ {legacy claim tenant}. The claim is
    // a TRANSITIONAL owner grant (existing single-tenant users); migrate it to a Membership
    // on first sight so enforcement moves fully onto the table. (Slice 3's member-removal
    // must never target claim-holders — they own their own workspace.)
    const memberships = await this.memberships.listForUser(user.userId);
    const claim = user.claimTenant;
    if (claim && !memberships.some((m) => m.tenantId === claim)) {
      // Best-effort, NON-authorizing: access is granted via the claim union below, not by
      // this write succeeding. Awaiting-and-throwing would 500 an already-authorized user
      // on a transient DB error or a P2002 race (the SPA fires several first-login requests
      // at once, all missing the cache). Swallow + log; a later request retries the upsert.
      await this.memberships
        .ensureMembership(user.userId, claim, "owner", user.email)
        .catch((err) =>
          this.logger.warn(
            `claim→Membership backfill failed for user=${user.userId} tenant=${claim}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
    }
    const roleOf = (tenantId: string): string | undefined =>
      memberships.find((m) => m.tenantId === tenantId)?.role ??
      (tenantId === claim ? "owner" : undefined);

    // User-scoped routes (/me, the switcher, create-workspace) are about the USER, not a
    // workspace — they never scope data by the active tenant. So they IGNORE the header for
    // enforcement: a stale/foreign X-Workspace-Id (e.g. a previous user on a shared browser)
    // must not 403 the very call that lists/creates workspaces. Workspace-scoped routes
    // enforce membership on an explicit target (attack #1) and fail closed otherwise.
    const isUserScoped = this.reflector.getAllAndOverride<boolean>(
      IS_USER_SCOPED_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );

    // Resolve the ACTIVE workspace. An explicit target must be one the user belongs to; with
    // no (valid) target, default to the user's own workspace (their claim, or their sole
    // membership) so existing single-workspace callers keep working before the SPA sends the
    // header.
    const targetAllowed =
      !!target &&
      (memberships.some((m) => m.tenantId === target) || target === claim);
    let active: string | undefined;
    if (targetAllowed) {
      active = target;
    } else if (target && !isUserScoped) {
      // A workspace-scoped route explicitly targeting a workspace the user isn't in.
      throw new ForbiddenException("Not a workspace member");
    } else {
      active =
        claim ??
        (memberships.length === 1 ? memberships[0].tenantId : undefined);
    }

    if (!active) {
      // No resolvable workspace. User-scoped routes need only the authenticated user; every
      // other route is workspace-scoped and FAILS CLOSED — a tenant-less principal must
      // never fall through to a shared empty-tenant query.
      if (!isUserScoped) throw new ForbiddenException("No workspace selected");
      req.principal = {
        tenantId: "",
        userId: user.userId,
        subject: user.userId,
        email: user.email,
        emailVerified: user.emailVerified,
      };
      return true;
    }

    req.principal = {
      tenantId: active,
      userId: user.userId,
      subject: user.userId,
      email: user.email,
      emailVerified: user.emailVerified,
      role: roleOf(active),
    };
    return true;
  }
}
