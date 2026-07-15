-- Env-bind trigger endpoints + ApiToken (design ENVIRONMENTS.md §3, Slice 4). A triggered run lands
-- in the ENDPOINT's env; an nry_ token may carry an optional bound env.

-- 1) Add columns. Endpoints get environmentId nullable (backfilled below → NOT NULL). ApiToken's
--    env binding is genuinely optional (null = unbound), so it stays nullable.
ALTER TABLE "WebhookEndpoint" ADD COLUMN "environmentId" TEXT;
ALTER TABLE "FormEndpoint"    ADD COLUMN "environmentId" TEXT;
ALTER TABLE "ChatEndpoint"    ADD COLUMN "environmentId" TEXT;
ALTER TABLE "ApiToken"        ADD COLUMN "environmentId" TEXT;

-- 2) Ensure a default "prod" env exists for every tenant that has endpoints (idempotent — 2a/2b may
--    already have created it).
INSERT INTO "Environment" ("id", "tenantId", "name", "slug", "isDefault")
SELECT gen_random_uuid(), t."tenantId", 'Production', 'prod', true
FROM (
  SELECT DISTINCT "tenantId" FROM "WebhookEndpoint"
  UNION SELECT DISTINCT "tenantId" FROM "FormEndpoint"
  UNION SELECT DISTINCT "tenantId" FROM "ChatEndpoint"
) AS t
ON CONFLICT ("tenantId", "slug") DO NOTHING;

-- 3) Backfill existing endpoints to the tenant's default env (existing triggers keep firing in prod).
UPDATE "WebhookEndpoint" w SET "environmentId" = e."id"
  FROM "Environment" e WHERE e."tenantId" = w."tenantId" AND e."slug" = 'prod';
UPDATE "FormEndpoint" f SET "environmentId" = e."id"
  FROM "Environment" e WHERE e."tenantId" = f."tenantId" AND e."slug" = 'prod';
UPDATE "ChatEndpoint" c SET "environmentId" = e."id"
  FROM "Environment" e WHERE e."tenantId" = c."tenantId" AND e."slug" = 'prod';

-- 4) Endpoints require an env now (ApiToken stays nullable — unbound is valid).
ALTER TABLE "WebhookEndpoint" ALTER COLUMN "environmentId" SET NOT NULL;
ALTER TABLE "FormEndpoint"    ALTER COLUMN "environmentId" SET NOT NULL;
ALTER TABLE "ChatEndpoint"    ALTER COLUMN "environmentId" SET NOT NULL;

-- 5) Referential integrity. Endpoints: RESTRICT (an env with live triggers can't be deleted).
--    ApiToken: SET NULL (deleting an env just unbinds the token → it falls back to the default).
ALTER TABLE "WebhookEndpoint"
  ADD CONSTRAINT "WebhookEndpoint_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FormEndpoint"
  ADD CONSTRAINT "FormEndpoint_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChatEndpoint"
  ADD CONSTRAINT "ChatEndpoint_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApiToken"
  ADD CONSTRAINT "ApiToken_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 6) Index (tenantId, environmentId) for env-scoped listing. The composite is tenantId-leading, so it
--    also serves the existing list-by-tenant query — making the standalone tenantId indexes on
--    FormEndpoint/ChatEndpoint redundant. Drop those so each table keeps exactly one covering index.
DROP INDEX IF EXISTS "FormEndpoint_tenantId_idx";
DROP INDEX IF EXISTS "ChatEndpoint_tenantId_idx";
CREATE INDEX "WebhookEndpoint_tenantId_environmentId_idx" ON "WebhookEndpoint"("tenantId", "environmentId");
CREATE INDEX "FormEndpoint_tenantId_environmentId_idx" ON "FormEndpoint"("tenantId", "environmentId");
CREATE INDEX "ChatEndpoint_tenantId_environmentId_idx" ON "ChatEndpoint"("tenantId", "environmentId");
