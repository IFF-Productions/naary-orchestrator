-- #464 (environmentId on AuditEvent) — EXPAND-ONLY: one nullable column, no backfill, no drops.
-- The audit interceptor resolves the actor's selected env (slug from the SPA, uuid from an
-- env-bound token) to a canonical Environment.id and stamps it; NULL when no env was selected.
-- The actor's env CONTEXT, not a resource FK — hence nullable and no foreign key.
ALTER TABLE "AuditEvent" ADD COLUMN "environmentId" TEXT;
