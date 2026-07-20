-- Slice 2 (REDESIGN-FUNCTIONALITY-GAPS.md) — per-node timing + cost. EXPAND-ONLY:
-- nullable columns, no backfill, no drops — old rows stay NULL and consumers render "—"
-- (never fabricated numbers). NOTE: UsageEvent.nodeId already exists (NOT NULL, part of
-- the idempotency unique key), so the design doc's "add nodeId" is a no-op here.

-- Execution: terminal-transition stamp + compact failure classification.
ALTER TABLE "Execution" ADD COLUMN "finishedAt" TIMESTAMP(3);
ALTER TABLE "Execution" ADD COLUMN "failureKind" TEXT;

-- UsageEvent: node-type tag + in-activity measured call duration for by-node-type rollups.
ALTER TABLE "UsageEvent" ADD COLUMN "nodeType" TEXT;
ALTER TABLE "UsageEvent" ADD COLUMN "durationMs" INTEGER;
