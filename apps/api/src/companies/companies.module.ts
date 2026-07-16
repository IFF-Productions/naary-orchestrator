import { Module } from "@nestjs/common";
import { CompaniesController } from "./companies.controller";
import { CompanyService } from "./company.service";

/**
 * Companies foundation (COMPANIES.md Slice 1) — additive, behavior-neutral. Adds the company
 * grouping + uid-keyed CompanyMembership + owner-authorized attach/detach of workspaces. No
 * cross-workspace reads yet (that's Slice 2+).
 */
@Module({
  controllers: [CompaniesController],
  providers: [CompanyService],
  exports: [CompanyService],
})
export class CompaniesModule {}
