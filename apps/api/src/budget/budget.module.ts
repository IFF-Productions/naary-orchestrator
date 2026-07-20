import { Module } from "@nestjs/common";
import { BudgetController } from "./budget.controller";
import { BudgetResumeService } from "./budget-resume.service";
import { BudgetService } from "./budget.service";

@Module({
  controllers: [BudgetController],
  // BudgetResumeService owns the pause-not-fail resume delivery (Slice 3): the PUT
  // path calls it and its boot hook runs the month-rollover reconcile.
  providers: [BudgetService, BudgetResumeService],
})
export class BudgetModule {}
