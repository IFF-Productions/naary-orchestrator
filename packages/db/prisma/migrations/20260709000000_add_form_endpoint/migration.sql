-- CreateTable
CREATE TABLE "FormEndpoint" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FormEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FormEndpoint_tenantId_idx" ON "FormEndpoint"("tenantId");
