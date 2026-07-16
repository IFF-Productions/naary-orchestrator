-- Tag Execution + UsageEvent with environmentId (design ENVIRONMENTS.md Slice 6). PURE read-model /
-- cost-visibility tags: NULLABLE, NO FK, NO unique/index changes. Billing stays one-bill-per-tenant
-- (the budget aggregate/reservation/gate never read these columns), and a historical record must
-- not block env deletion — so no RESTRICT/SET NULL FK, and a dangling id just degrades gracefully.

-- 1) Add nullable tag columns.
ALTER TABLE "Execution"  ADD COLUMN "environmentId" TEXT;
ALTER TABLE "UsageEvent" ADD COLUMN "environmentId" TEXT;

-- 2) Ensure a default "prod" env exists for every tenant that has runs/usage (idempotent).
INSERT INTO "Environment" ("id", "tenantId", "name", "slug", "isDefault")
SELECT gen_random_uuid(), t."tenantId", 'Production', 'prod', true
FROM (
  SELECT DISTINCT "tenantId" FROM "Execution"
  UNION SELECT DISTINCT "tenantId" FROM "UsageEvent"
) AS t
ON CONFLICT ("tenantId", "slug") DO NOTHING;

-- 3) Backfill existing rows to the tenant's default env so historical runs/spend show under
--    "Production" once per-env views land. Stays nullable (a row whose tenant somehow has no default
--    env keeps NULL → display reads fall back to the default env id at read time).
UPDATE "Execution" x SET "environmentId" = e."id"
  FROM "Environment" e WHERE e."tenantId" = x."tenantId" AND e."slug" = 'prod';
UPDATE "UsageEvent" u SET "environmentId" = e."id"
  FROM "Environment" e WHERE e."tenantId" = u."tenantId" AND e."slug" = 'prod';
