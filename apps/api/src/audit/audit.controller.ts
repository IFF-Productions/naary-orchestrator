import { Controller, Get, Param } from "@nestjs/common";
import { type AuditEventView, AuditService } from "./audit.service";

/** tenantId from the path; AuthGuard enforces path-tenant == token-tenant. */
@Controller("tenants/:id/audit")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Param("id") tenantId: string): Promise<AuditEventView[]> {
    return this.audit.list(tenantId);
  }
}
