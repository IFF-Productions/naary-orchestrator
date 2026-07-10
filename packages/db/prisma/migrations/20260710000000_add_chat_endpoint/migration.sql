-- CreateTable
CREATE TABLE "ChatEndpoint" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatEndpoint_tenantId_idx" ON "ChatEndpoint"("tenantId");
