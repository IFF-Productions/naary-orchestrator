-- Soft + reversible workspace archive (COMPANIES.md Slice 4): hides the workspace from the
-- switcher; runs/schedules/budgets untouched.
ALTER TABLE "TenantSettings" ADD COLUMN "archivedAt" TIMESTAMP(3);
