-- CreateTable
CREATE TABLE "ErrorHandler" (
    "tenantId" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "errorWorkflowKey" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErrorHandler_pkey" PRIMARY KEY ("tenantId","workflowKey")
);
