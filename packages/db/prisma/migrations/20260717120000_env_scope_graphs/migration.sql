-- Env-scope GraphDefinition + WorkflowActivation (design ENVIRONMENTS.md Slice 2b).
-- Strategy (compat shim): add environmentId NULLABLE → backfill every existing row to the tenant's
-- default "prod" env → make it NOT NULL → swap the composite key/unique to include environmentId.
-- Idempotent about the default env: 2a's switcher may have already lazily created a `prod` env for
-- some tenants (ON CONFLICT DO NOTHING covers both cases).

-- 1) Add the column, nullable for the backfill window.
ALTER TABLE "GraphDefinition" ADD COLUMN "environmentId" TEXT;
ALTER TABLE "WorkflowActivation" ADD COLUMN "environmentId" TEXT;

-- 2) Ensure every tenant that has graphs/activation rows has a default "prod" env.
INSERT INTO "Environment" ("id", "tenantId", "name", "slug", "isDefault")
SELECT gen_random_uuid(), t."tenantId", 'Production', 'prod', true
FROM (
  SELECT DISTINCT "tenantId" FROM "GraphDefinition"
  UNION
  SELECT DISTINCT "tenantId" FROM "WorkflowActivation"
) AS t
ON CONFLICT ("tenantId", "slug") DO NOTHING;

-- 3) Backfill environmentId = the tenant's default env id.
UPDATE "GraphDefinition" g
SET "environmentId" = e."id"
FROM "Environment" e
WHERE e."tenantId" = g."tenantId" AND e."slug" = 'prod';

UPDATE "WorkflowActivation" w
SET "environmentId" = e."id"
FROM "Environment" e
WHERE e."tenantId" = w."tenantId" AND e."slug" = 'prod';

-- 4) Now that every row is backfilled, enforce NOT NULL.
ALTER TABLE "GraphDefinition" ALTER COLUMN "environmentId" SET NOT NULL;
ALTER TABLE "WorkflowActivation" ALTER COLUMN "environmentId" SET NOT NULL;

-- 5) GraphDefinition: swap the version-unique + lookup index to include environmentId.
DROP INDEX "GraphDefinition_tenantId_workflowKey_version_key";
DROP INDEX "GraphDefinition_tenantId_workflowKey_idx";
CREATE UNIQUE INDEX "GraphDefinition_tenantId_environmentId_workflowKey_version_key"
  ON "GraphDefinition"("tenantId", "environmentId", "workflowKey", "version");
CREATE INDEX "GraphDefinition_tenantId_environmentId_workflowKey_idx"
  ON "GraphDefinition"("tenantId", "environmentId", "workflowKey");

-- 6) WorkflowActivation: repoint the primary key to include environmentId.
ALTER TABLE "WorkflowActivation" DROP CONSTRAINT "WorkflowActivation_pkey";
ALTER TABLE "WorkflowActivation"
  ADD CONSTRAINT "WorkflowActivation_pkey" PRIMARY KEY ("tenantId", "environmentId", "workflowKey");

-- 7) Referential integrity: environmentId must point at a real Environment. ON DELETE RESTRICT so
-- an environment holding workflows/activation can't be deleted out from under them (matches the
-- "can't delete an env that still holds data" rule). Rows are backfilled above, so this is safe.
ALTER TABLE "GraphDefinition"
  ADD CONSTRAINT "GraphDefinition_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkflowActivation"
  ADD CONSTRAINT "WorkflowActivation_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
