-- Env-scope Schedule + PollState (design ENVIRONMENTS.md §7, the env-scoped-schedules slice —
-- the FINAL environments slice): the env becomes part of the schedule IDENTITY, so a sandbox
-- poll/cron schedule fires sandbox's graph and cursor, never prod's. Same expand pattern as 6b
-- (env_scope_notifications_pins) including its NULL-guarded backfill: add nullable -> ensure
-- default env -> backfill only NULL rows -> NOT NULL -> Cascade FK -> index/PK swap.

-- 1) Add columns (nullable; backfilled below).
ALTER TABLE "Schedule" ADD COLUMN "environmentId" TEXT;
ALTER TABLE "PollState" ADD COLUMN "environmentId" TEXT;

-- 2) Ensure a default "prod" env exists for every tenant holding a schedule or poll cursor
--    (idempotent — tenants that have used the app since Slice 1 already have one).
INSERT INTO "Environment" ("id", "tenantId", "name", "slug", "isDefault")
SELECT gen_random_uuid(), t."tenantId", 'Production', 'prod', true
FROM (
  SELECT DISTINCT "tenantId" FROM "Schedule"
  UNION
  SELECT DISTINCT "tenantId" FROM "PollState"
) AS t
ON CONFLICT ("tenantId", "slug") DO NOTHING;

-- 3) Backfill existing rows to the tenant's default env (schedules were effectively
--    default-env-only before this slice, so the default env is the CORRECT owner — their
--    Temporal schedule ids still carry the legacy no-env format; the boot-time reconcile +
--    sync-time legacy deletes migrate those). NULL-guarded so the backfill is idempotent and
--    can never clobber a row a newer API/worker already scoped mid-deploy.
UPDATE "Schedule" s
SET "environmentId" = e."id"
FROM "Environment" e
WHERE e."tenantId" = s."tenantId" AND e."slug" = 'prod'
  AND s."environmentId" IS NULL;

UPDATE "PollState" p
SET "environmentId" = e."id"
FROM "Environment" e
WHERE e."tenantId" = p."tenantId" AND e."slug" = 'prod'
  AND p."environmentId" IS NULL;

-- 4) Require an env from here on (HARD scope, design §3).
ALTER TABLE "Schedule" ALTER COLUMN "environmentId" SET NOT NULL;
ALTER TABLE "PollState" ALTER COLUMN "environmentId" SET NOT NULL;

-- 5) FKs — CASCADE: deleting an env takes its schedules/cursors with it (disposable trigger
--    config; must not block env deletion).
ALTER TABLE "Schedule"
  ADD CONSTRAINT "Schedule_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PollState"
  ADD CONSTRAINT "PollState_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 6) PollState PK gains environmentId (adjacent statements — one transaction, no PK-less window).
ALTER TABLE "PollState" DROP CONSTRAINT "PollState_pkey";
ALTER TABLE "PollState"
  ADD CONSTRAINT "PollState_pkey" PRIMARY KEY ("tenantId", "environmentId", "workflowKey", "nodeId");

-- 7) Index swap on Schedule.
DROP INDEX "Schedule_tenantId_idx";
CREATE INDEX "Schedule_tenantId_environmentId_idx"
  ON "Schedule"("tenantId", "environmentId");

-- 8) Deactivate NON-default-env activation rows (user decision): non-default envs' schedules
--    never fired before this slice (schedules were default-env-only), so an "active" flag in
--    sandbox/UAT was a statement of intent with no firing behavior behind it. Now that this
--    slice makes non-default schedules real, an explicit re-enable per env prevents surprise
--    firing the moment the deploy lands — flipping the toggle back on is a deliberate act.
UPDATE "WorkflowActivation" wa
SET "active" = false
FROM "Environment" e
WHERE e."id" = wa."environmentId"
  AND e."isDefault" = false
  AND wa."active" = true;
