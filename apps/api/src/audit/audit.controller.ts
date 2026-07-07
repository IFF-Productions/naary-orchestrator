import { Controller, Get, Param } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { ApiEndpoint } from "../swagger/api-decorators";
import { AuditEventResponse } from "./audit.response";
import { type AuditEventView, AuditService } from "./audit.service";

/** tenantId from the path; AuthGuard enforces path-tenant == token-tenant. */
@ApiBearerAuth("bearer")
@Controller("tenants/:id/audit")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @ApiEndpoint({
    summary: "List activity log",
    description: "Tenant-scoped audit events, newest first.",
    ok: [AuditEventResponse],
  })
  @Get()
  list(@Param("id") tenantId: string): Promise<AuditEventView[]> {
    return this.audit.list(tenantId);
  }
}
