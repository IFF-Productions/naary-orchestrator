-- CreateTable
CREATE TABLE "WorkflowActivation" (
    "tenantId" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowActivation_pkey" PRIMARY KEY ("tenantId","workflowKey")
);
