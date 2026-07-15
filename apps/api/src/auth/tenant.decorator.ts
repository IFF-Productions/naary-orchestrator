import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

/** The authenticated caller. Resolved by AuthGuard — never trusted from the path/body.
 *  For Firebase users, `tenantId` is the ACTIVE workspace, membership-checked against the
 *  `X-Workspace-Id` header or `/tenants/:id` path; for `nry_` API tokens it's the token's
 *  single tenant. */
export interface Principal {
  /** Active workspace id. `""` only on user-scoped routes for a user with no resolved
   *  workspace — the guard fails workspace-scoped routes closed (403) before a controller
   *  runs, so `""` never reaches a workspace data query. */
  tenantId: string;
  /** Firebase uid (absent for `nry_` API-token principals). */
  userId?: string;
  /** = `userId` for Firebase users; absent for API tokens. Kept for audit/logging. */
  subject?: string;
  email?: string;
  /** Firebase `email_verified` — gates workspace creation (design Path A). Absent for
   *  API-token principals. */
  emailVerified?: boolean;
  /** Role in the active workspace ('owner' | 'admin' | 'member'); 'owner' for API tokens. */
  role?: string;
  /** RAW `X-Environment-Id` header (env id or slug), stashed by the guard WITHOUT a DB lookup
   *  (design ENVIRONMENTS.md §4). Env-scoped controllers resolve it to a concrete env id via
   *  `EnvironmentsService.resolveEnvId` at the query boundary (undefined → the tenant's default). */
  environmentSel?: string;
}

export interface RequestWithPrincipal {
  principal?: Principal;
}

/** Injects the authenticated tenantId (set by AuthGuard). Use instead of reading it
 *  from the path/body. */
export const TenantId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<RequestWithPrincipal>();
    return req.principal?.tenantId ?? "";
  },
);

/** Injects the full authenticated principal (tenantId + optional subject). */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const req = ctx.switchToHttp().getRequest<RequestWithPrincipal>();
    return req.principal ?? { tenantId: "" };
  },
);

/** Injects the resolved environment SELECTOR the guard stashed on the principal, or undefined.
 *  For a Firebase user / unbound token this is the raw `X-Environment-Id` header; for an
 *  env-BOUND API token it is the token's own env (the binding wins over the header — the guard
 *  403s a bound token that also sends the header). Env-scoped controllers pass it to
 *  `EnvironmentsService.resolveEnvId(tenantId, sel)` (undefined → the tenant's default env). */
export const EnvironmentSel = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const req = ctx.switchToHttp().getRequest<RequestWithPrincipal>();
    return req.principal?.environmentSel;
  },
);
