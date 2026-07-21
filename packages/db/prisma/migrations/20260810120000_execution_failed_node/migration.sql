-- #525 (run-detail failed-run recovery) — EXPAND-ONLY. The interpreter stamps, on the THROWN
-- failure path, the node it died on + the nodes that had already run, so the run-detail UI can
-- mark the failed node (not "skipped") and show upstream nodes as done. Node IDs only, never
-- ctx output content (privacy checklist).
ALTER TABLE "Execution" ADD COLUMN "failedNodeId" TEXT;
ALTER TABLE "Execution" ADD COLUMN "executedNodeIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
