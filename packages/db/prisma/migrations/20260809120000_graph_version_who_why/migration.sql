-- #488 (workflow version-history actor/message) — EXPAND-ONLY: two nullable columns, no backfill.
-- savedBy = display string for who saved the version (email / "api-token"); NULL for internal +
-- promote copy-in + pre-feature rows. saveMessage = optional commit note (API/CLI-settable).
ALTER TABLE "GraphDefinition" ADD COLUMN "savedBy" TEXT;
ALTER TABLE "GraphDefinition" ADD COLUMN "saveMessage" TEXT;
