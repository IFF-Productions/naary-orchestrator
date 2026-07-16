-- Env-scope TenantCredential + Connection (design ENVIRONMENTS.md §3, Slice 5a). Separate provider
-- keys / integrations per environment (sandbox test keys vs prod live keys). Additive + reversible
-- per step: add nullable -> backfill to the tenant's default env -> NOT NULL -> FK -> swap uniques.
-- The at-rest credential AAD stays bound to (tenantId, provider) — env is a row-LOOKUP concern only,
-- so backfilled default-env rows keep decrypting.

-- 1) Add columns (nullable; backfilled below).
ALTER TABLE "TenantCredential" ADD COLUMN "environmentId" TEXT;
ALTER TABLE "Connection"       ADD COLUMN "environmentId" TEXT;

-- 2) Ensure a default "prod" env exists for every tenant that holds a credential or connection
--    (idempotent — earlier slices may already have created it).
INSERT INTO "Environment" ("id", "tenantId", "name", "slug", "isDefault")
SELECT gen_random_uuid(), t."tenantId", 'Production', 'prod', true
FROM (
  SELECT DISTINCT "tenantId" FROM "TenantCredential"
  UNION SELECT DISTINCT "tenantId" FROM "Connection"
) AS t
ON CONFLICT ("tenantId", "slug") DO NOTHING;

-- 3) Backfill existing rows to the tenant's default env (they keep working exactly as before).
UPDATE "TenantCredential" c SET "environmentId" = e."id"
  FROM "Environment" e WHERE e."tenantId" = c."tenantId" AND e."slug" = 'prod';
UPDATE "Connection" cn SET "environmentId" = e."id"
  FROM "Environment" e WHERE e."tenantId" = cn."tenantId" AND e."slug" = 'prod';

-- 4) Require an env now.
ALTER TABLE "TenantCredential" ALTER COLUMN "environmentId" SET NOT NULL;
ALTER TABLE "Connection"       ALTER COLUMN "environmentId" SET NOT NULL;

-- 5) Referential integrity: RESTRICT (an env holding creds/connections can't be deleted — consistent
--    with the trigger-endpoint FKs from Slice 4; §2 already refuses deleting a non-empty env).
ALTER TABLE "TenantCredential"
  ADD CONSTRAINT "TenantCredential_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Connection"
  ADD CONSTRAINT "Connection_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6) Swap the uniques to include environmentId — this is what lets two envs hold separate keys /
--    integrations for the same (provider) / (type,label). Drop the old, add the composite.
DROP INDEX "TenantCredential_tenantId_provider_key";
CREATE UNIQUE INDEX "TenantCredential_tenantId_environmentId_provider_key"
  ON "TenantCredential"("tenantId", "environmentId", "provider");
DROP INDEX "Connection_tenantId_type_label_key";
CREATE UNIQUE INDEX "Connection_tenantId_environmentId_type_label_key"
  ON "Connection"("tenantId", "environmentId", "type", "label");
