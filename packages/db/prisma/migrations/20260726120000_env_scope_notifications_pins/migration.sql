-- Env-scope NotificationChannel + PinnedData (design ENVIRONMENTS.md §3, Slice 6b): per-env rows
-- so a sandbox failure never pages prod's Slack, and sandbox pins never leak into a prod node
-- test. Same expand pattern as tag_execution_usage_env: add nullable -> ensure default env ->
-- backfill -> NOT NULL -> FK -> index/PK swap. FKs are ON DELETE CASCADE (NOT Restrict):
-- channels and pins are disposable config/authoring aids and must not block env deletion.

-- 1) Add columns (nullable; backfilled below).
ALTER TABLE "NotificationChannel" ADD COLUMN "environmentId" TEXT;
ALTER TABLE "PinnedData" ADD COLUMN "environmentId" TEXT;

-- 2) Ensure a default "prod" env exists for every tenant holding a channel or pin (idempotent —
--    tenants that have used the app since Slice 1 already have one).
INSERT INTO "Environment" ("id", "tenantId", "name", "slug", "isDefault")
SELECT gen_random_uuid(), t."tenantId", 'Production', 'prod', true
FROM (
  SELECT DISTINCT "tenantId" FROM "NotificationChannel"
  UNION
  SELECT DISTINCT "tenantId" FROM "PinnedData"
) AS t
ON CONFLICT ("tenantId", "slug") DO NOTHING;

-- 3) Backfill existing rows to the tenant's default env (pre-6b rows keep working as before).
UPDATE "NotificationChannel" n
SET "environmentId" = e."id"
FROM "Environment" e
WHERE e."tenantId" = n."tenantId" AND e."slug" = 'prod';

UPDATE "PinnedData" p
SET "environmentId" = e."id"
FROM "Environment" e
WHERE e."tenantId" = p."tenantId" AND e."slug" = 'prod';

-- 4) Require an env from here on (HARD scope, design §3).
ALTER TABLE "NotificationChannel" ALTER COLUMN "environmentId" SET NOT NULL;
ALTER TABLE "PinnedData" ALTER COLUMN "environmentId" SET NOT NULL;

-- 5) FKs — CASCADE: deleting an env takes its channels/pins with it.
ALTER TABLE "NotificationChannel"
  ADD CONSTRAINT "NotificationChannel_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PinnedData"
  ADD CONSTRAINT "PinnedData_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 6) PinnedData PK gains environmentId (adjacent statements — one transaction, no PK-less window).
ALTER TABLE "PinnedData" DROP CONSTRAINT "PinnedData_pkey";
ALTER TABLE "PinnedData"
  ADD CONSTRAINT "PinnedData_pkey" PRIMARY KEY ("tenantId", "environmentId", "workflowKey", "nodeId");

-- 7) Index swaps. The old PinnedData index (and its would-be env-scoped successor) is a strict
--    left prefix of the new PK — drop it, add nothing.
DROP INDEX "PinnedData_tenantId_workflowKey_idx";
DROP INDEX "NotificationChannel_tenantId_idx";
CREATE INDEX "NotificationChannel_tenantId_environmentId_idx"
  ON "NotificationChannel"("tenantId", "environmentId");
