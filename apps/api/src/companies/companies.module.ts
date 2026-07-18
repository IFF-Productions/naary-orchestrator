import { Module } from "@nestjs/common";
import { EnvironmentsModule } from "../environments/environments.module";
import { ExecutionsModule } from "../executions/executions.module";
import { GraphsModule } from "../graphs/graphs.module";
import { CompaniesController } from "./companies.controller";
import { CompanyService } from "./company.service";

/**
 * Companies (COMPANIES.md) — additive, behavior-neutral. Slice 1: company grouping + uid-keyed
 * CompanyMembership + owner-authorized attach/detach. Slice 2: usage rollup. Slice 3: company-authz
 * READ-ONLY visibility into member workspaces' runs/workflows — the imported modules power those
 * delegated reads, always behind assertCompanyMember (§4).
 */
@Module({
  imports: [ExecutionsModule, GraphsModule, EnvironmentsModule],
  controllers: [CompaniesController],
  providers: [CompanyService],
  exports: [CompanyService],
})
export class CompaniesModule {}
