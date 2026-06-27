import { Controller, Get } from "@nestjs/common";
import { CurrentPrincipal, type Principal } from "./tenant.decorator";

/**
 * "Who am I": returns the authenticated principal so the SPA knows its own
 * tenantId (for tenant-scoped routes like /tenants/:id/usage) without trusting
 * anything client-side. Works for both auth modes — tenantId is resolved by
 * AuthGuard from the Firebase `tenant` custom claim or the API token.
 */
@Controller("me")
export class MeController {
  @Get()
  me(@CurrentPrincipal() principal: Principal): {
    tenantId: string;
    subject?: string;
  } {
    return { tenantId: principal.tenantId, subject: principal.subject };
  }
}
