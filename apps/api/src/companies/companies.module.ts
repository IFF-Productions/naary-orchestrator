import { Module } from "@nestjs/common";
import { EnvironmentsModule } from "../environments/environments.module";
import { ExecutionsModule } from "../executions/executions.module";
import { GraphsModule } from "../graphs/graphs.module";
import { CompaniesController } from "./companies.controller";
import { CompanyGroupsController } from "./company-groups.controller";
import { CompanyGroupsService } from "./company-groups.service";
import { CompanyService } from "./company.service";

/**
 * Companies (COMPANIES.md) — additive, behavior-neutral. Slice 1: company grouping + uid-keyed
 * CompanyMembership + owner-authorized attach/detach. Slice 2: usage rollup. Slice 3: company-authz
 * READ-ONLY visibility into member workspaces' runs/workflows — the imported modules power those
 * delegated reads, always behind assertCompanyMember (§4).
 */
// Company permission groups (RBAC-GROUPS §9): CompanyGroupsService + controller. Their
// PermissionsService dependency comes from the @Global PermissionsModule's export — no
// CompaniesModule↔PermissionsModule import edge, hence no module cycle.
@Module({
  imports: [ExecutionsModule, GraphsModule, EnvironmentsModule],
  controllers: [CompaniesController, CompanyGroupsController],
  providers: [CompanyService, CompanyGroupsService],
  exports: [CompanyService],
})
export class CompaniesModule {}
