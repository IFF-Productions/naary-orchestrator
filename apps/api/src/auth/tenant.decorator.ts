import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

/** The authenticated caller. `tenantId` is resolved from the API token by AuthGuard —
 *  never trusted from the request path/body. */
export interface Principal {
  tenantId: string;
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
