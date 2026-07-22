-- Issue #463 "Search executions by contained data".
-- Adds an indexed, searchable projection of each run's TRIGGER INPUT so the Runs list can filter
-- by the data a run contains (`GET /executions?q=<text>`). Expand-only: a nullable column + a
-- concurrent-safe extension + a GIN index. No destructive ops; existing rows get NULL (they simply
-- won't match a data search until re-run — acceptable for a backfill-free projection).

-- pg_trgm powers substring (ILIKE / Prisma `contains`) search via a GIN index. IF NOT EXISTS so a
-- shared database that already has the extension is a no-op.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- The projection column: serialized, length-capped trigger input (never prompt/completion text).
ALTER TABLE "Execution" ADD COLUMN "searchText" TEXT;

-- Trigram GIN index so `WHERE "searchText" ILIKE '%q%'` (what Prisma `contains` emits) is indexable
-- rather than a full-table scan. Tenant scoping stays in the query's WHERE (tenantId is always ANDed).
CREATE INDEX "Execution_searchText_trgm_idx" ON "Execution" USING gin ("searchText" gin_trgm_ops);
