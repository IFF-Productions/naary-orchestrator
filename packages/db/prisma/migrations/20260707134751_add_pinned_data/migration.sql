-- AlterTable
ALTER TABLE "NotificationSettings" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "PinnedData" (
    "tenantId" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "output" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PinnedData_pkey" PRIMARY KEY ("tenantId","workflowKey","nodeId")
);

-- CreateIndex
CREATE INDEX "PinnedData_tenantId_workflowKey_idx" ON "PinnedData"("tenantId", "workflowKey");
