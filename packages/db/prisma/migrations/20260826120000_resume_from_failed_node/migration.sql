-- Resume-from-failed-node (docs/design/RESUME-FROM-FAILED-NODE.md).
-- Expand/contract safe: four ADDITIVE nullable columns, so an older API image ignores them and a
-- rollback loses only the ability to resume runs that failed in the window.
--
-- `resumeSnapshot` holds a claim-check REFERENCE to object storage, never ctx content — the
-- "node IDs only, never ctx output content" rule on this table is unchanged.
ALTER TABLE "Execution" ADD COLUMN "resumeSnapshot" JSONB;
ALTER TABLE "Execution" ADD COLUMN "resumeStepCount" INTEGER;
ALTER TABLE "Execution" ADD COLUMN "resumeMergeArrivals" JSONB;
ALTER TABLE "Execution" ADD COLUMN "resumedFromId" TEXT;

-- Lineage lookups ("show me the runs resumed from this one") are rare but must not table-scan a
-- tenant's whole history. Partial: only resumed rows carry the column.
CREATE INDEX "Execution_resumedFromId_idx" ON "Execution" ("resumedFromId") WHERE "resumedFromId" IS NOT NULL;
