-- Slice 3 (REDESIGN-FUNCTIONALITY-GAPS.md) — budget alert threshold + pause-not-fail.
-- EXPAND-ONLY: nullable columns / defaulted boolean, no backfill, no drops. Old rows keep
-- NULL (no alert configured / not paused) and the new boolean defaults OFF so no existing
-- channel starts receiving budget alerts without opting in.

-- TenantBudget: the alert threshold (% of monthlyCapUsd) + the once-per-calendar-month
-- alert marker ("YYYY-MM"), claimed transactionally with the reservation crossing check.
ALTER TABLE "TenantBudget" ADD COLUMN "alertThresholdPct" INTEGER;
ALTER TABLE "TenantBudget" ADD COLUMN "lastAlertMonth" TEXT;

-- NotificationChannel: per-channel opt-in for the budgetThreshold event (default false).
ALTER TABLE "NotificationChannel" ADD COLUMN "onBudgetThreshold" BOOLEAN NOT NULL DEFAULT false;

-- Execution: when the run last entered awaiting_budget (pause-not-fail read model) — the
-- month-rollover boot reconcile keys off this to signal budgetResume after a new month starts.
ALTER TABLE "Execution" ADD COLUMN "budgetPausedAt" TIMESTAMP(3);
