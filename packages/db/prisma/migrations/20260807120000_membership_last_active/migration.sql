-- #489 (Team member last-active timestamps) — EXPAND-ONLY: one nullable column, no backfill,
-- no drops. The auth guard stamps it (DB-side-throttled) on each authenticated request in the
-- workspace; NULL means "not seen since this column was added". Telemetry only, never authz.
ALTER TABLE "Membership" ADD COLUMN "lastActiveAt" TIMESTAMP(3);
