-- Copy-on-promote lineage (design ENVIRONMENTS.md §6, Slice 3). Purely additive — a new audit
-- table, one row per promote of a workflow definition across environments.

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "fromEnvId" TEXT NOT NULL,
    "toEnvId" TEXT NOT NULL,
    "fromVersion" INTEGER NOT NULL,
    "toVersion" INTEGER NOT NULL,
    "actor" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — includes createdAt so the lineage read (order by createdAt desc) needs no sort.
CREATE INDEX "Promotion_tenantId_workflowKey_createdAt_idx" ON "Promotion"("tenantId", "workflowKey", "createdAt");
