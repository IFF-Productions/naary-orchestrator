-- Workflow tags (n8n parity, RBAC program slice T1) — organizational metadata only, NOT
-- permission-bearing. Tags attach to (tenantId, workflowKey) TENANT-WIDE (not per env):
-- authoring metadata like the workflow's name, identical in every environment, so promote
-- carries them implicitly. WorkflowTag is a SOFT reference to the workflow key (no FK to
-- GraphDefinition — a key has no single row identity across versions/envs).

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowTag" (
    "tagId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowTag_pkey" PRIMARY KEY ("tagId","tenantId","workflowKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tag_tenantId_name_key" ON "Tag"("tenantId", "name");

-- CreateIndex
CREATE INDEX "Tag_tenantId_idx" ON "Tag"("tenantId");

-- CreateIndex
CREATE INDEX "WorkflowTag_tenantId_workflowKey_idx" ON "WorkflowTag"("tenantId", "workflowKey");

-- AddForeignKey
ALTER TABLE "WorkflowTag" ADD CONSTRAINT "WorkflowTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
