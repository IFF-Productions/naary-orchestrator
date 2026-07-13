-- Record the GraphDefinition.version a run snapshotted at start, so the Runs list /
-- run detail can show which workflow version executed, and "re-run at a chosen version"
-- has an anchor. Read-model-only, like status/cost — the interpreter pushes it; Temporal
-- stays the source of truth (the version also rides the run's memo + history).

-- AddColumn (nullable, no default → instant, no table rewrite). NULL for pre-migration
-- rows and any run whose version wasn't recorded.
ALTER TABLE "Execution" ADD COLUMN "graphVersion" INTEGER;
