-- Env-scope ErrorHandler (ENVIRONMENTS.md §3, slice-6 cleanup): per-env bindings so a sandbox
-- failure triggers sandbox's error handler, never prod's. Same expand pattern as 6b
-- (env_scope_notifications_pins), including the NULL-guarded backfill from its review: add
-- nullable -> ensure default env -> backfill only NULL rows -> NOT NULL -> Cascade FK -> PK swap.

-- 1) Add column (nullable; backfilled below).
ALTER TABLE "ErrorHandler" ADD COLUMN "environmentId" TEXT;

-- 2) Ensure a default "prod" env exists for every tenant holding a binding (idempotent).
INSERT INTO "Environment" ("id", "tenantId", "name", "slug", "isDefault")
SELECT gen_random_uuid(), t."tenantId", 'Production', 'prod', true
FROM (SELECT DISTINCT "tenantId" FROM "ErrorHandler") AS t
ON CONFLICT ("tenantId", "slug") DO NOTHING;

-- 3) Backfill existing rows to the tenant's default env. NULL-guarded so the backfill is
--    idempotent and can never clobber a row a newer API already scoped mid-deploy.
UPDATE "ErrorHandler" h
SET "environmentId" = e."id"
FROM "Environment" e
WHERE e."tenantId" = h."tenantId" AND e."slug" = 'prod'
  AND h."environmentId" IS NULL;

-- 4) Require an env from here on (HARD scope, design §3).
ALTER TABLE "ErrorHandler" ALTER COLUMN "environmentId" SET NOT NULL;

-- 5) FK — CASCADE: deleting an env takes its bindings with it.
ALTER TABLE "ErrorHandler"
  ADD CONSTRAINT "ErrorHandler_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 6) PK gains environmentId (adjacent statements — one transaction, no PK-less window).
ALTER TABLE "ErrorHandler" DROP CONSTRAINT "ErrorHandler_pkey";
ALTER TABLE "ErrorHandler"
  ADD CONSTRAINT "ErrorHandler_pkey" PRIMARY KEY ("tenantId", "environmentId", "workflowKey");
