import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

/** The authenticated caller. `tenantId` is resolved by AuthGuard (from a Keycloak
 *  JWT's `tenant` claim or an API token) — never trusted from the request path/body.
 *  `subject` is the OIDC user id when authenticated via Keycloak. */
export interface Principal {
  tenantId: string;
  subject?: string;
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
