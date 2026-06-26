-- CreateTable
CREATE TABLE "GraphDefinition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "graph" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GraphDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GraphDefinition_tenantId_workflowKey_idx" ON "GraphDefinition"("tenantId", "workflowKey");

-- CreateIndex
CREATE UNIQUE INDEX "GraphDefinition_tenantId_workflowKey_version_key" ON "GraphDefinition"("tenantId", "workflowKey", "version");

