-- Workflow evals (#575): golden datasets + batch eval runs + per-case verdicts.
-- EXPAND-only (three brand-new tables, no change to an existing one), so a rolling deploy is safe
-- in both directions — an old api/worker simply never touches them.

CREATE TABLE "EvalDataset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvalDataset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EvalDataset_tenantId_environmentId_workflowKey_name_key"
    ON "EvalDataset"("tenantId", "environmentId", "workflowKey", "name");
CREATE INDEX "EvalDataset_tenantId_environmentId_workflowKey_idx"
    ON "EvalDataset"("tenantId", "environmentId", "workflowKey");

ALTER TABLE "EvalDataset" ADD CONSTRAINT "EvalDataset_environmentId_fkey"
    FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EvalRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "graphVersion" INTEGER NOT NULL,
    "graphContentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "totalCases" INTEGER NOT NULL,
    "passed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "errored" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "EvalRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EvalRun_workflowId_key" ON "EvalRun"("workflowId");
CREATE INDEX "EvalRun_tenantId_workflowKey_startedAt_idx"
    ON "EvalRun"("tenantId", "workflowKey", "startedAt");
-- Serves the promote-screen comparison: "this content hash's eval history".
CREATE INDEX "EvalRun_tenantId_workflowKey_graphContentHash_idx"
    ON "EvalRun"("tenantId", "workflowKey", "graphContentHash");

ALTER TABLE "EvalRun" ADD CONSTRAINT "EvalRun_datasetId_fkey"
    FOREIGN KEY ("datasetId") REFERENCES "EvalDataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EvalCaseResult" (
    "id" TEXT NOT NULL,
    "evalRunId" TEXT NOT NULL,
    "caseName" TEXT NOT NULL,
    "executionId" TEXT,
    "verdict" TEXT NOT NULL,
    "score" DECIMAL(5,4),
    "costUsd" DECIMAL(12,6),
    "latencyMs" INTEGER,
    "assertions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvalCaseResult_pkey" PRIMARY KEY ("id")
);

-- Also the idempotency key for the per-case persist activity (a retry upserts, never duplicates).
CREATE UNIQUE INDEX "EvalCaseResult_evalRunId_caseName_key"
    ON "EvalCaseResult"("evalRunId", "caseName");
CREATE INDEX "EvalCaseResult_evalRunId_idx" ON "EvalCaseResult"("evalRunId");

ALTER TABLE "EvalCaseResult" ADD CONSTRAINT "EvalCaseResult_evalRunId_fkey"
    FOREIGN KEY ("evalRunId") REFERENCES "EvalRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
