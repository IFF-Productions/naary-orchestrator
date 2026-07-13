-- Soft-archive for runs: a nullable `archivedAt` on Execution lets a user hide a run from the
-- Runs list without deleting it. NULL = active (the default view); non-null = archived + when.
-- Read-model-only flag — no Temporal interaction; the worker's status/cost pushes never touch it.

-- AddColumn (nullable, no default → instant, no table rewrite)
ALTER TABLE "Execution" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- Index for the list views. The DEFAULT view (archivedAt IS NULL, an equality) gets both the
-- filter and the createdAt sort from this index; the ARCHIVED view (archivedAt IS NOT NULL, a
-- range) uses it to narrow the filter but createdAt isn't the leading sort key, so PG may still
-- sort (acceptable — archived is the rarer view). Mirrors the existing (tenantId, createdAt) index.
CREATE INDEX "Execution_tenantId_archivedAt_createdAt_idx" ON "Execution"("tenantId", "archivedAt", "createdAt");
