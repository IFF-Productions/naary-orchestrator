import { Global, Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { EnvironmentsModule } from "../environments/environments.module";
import { AuditController } from "./audit.controller";
import { AuditInterceptor } from "./audit.interceptor";
import { AuditService } from "./audit.service";

/** Global so the AuditInterceptor + AuditService are available app-wide. Imports
 *  EnvironmentsModule so the interceptor can resolve the actor's env selection to a
 *  canonical id (#464) — EnvironmentsService has no deps, so no cycle. */
@Global()
@Module({
  imports: [EnvironmentsModule],
  controllers: [AuditController],
  providers: [
    AuditService,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditService],
})
export class AuditModule {}
