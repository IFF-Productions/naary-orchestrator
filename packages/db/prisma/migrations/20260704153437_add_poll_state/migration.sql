-- CreateTable
CREATE TABLE "PollState" (
    "tenantId" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "lastKey" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PollState_pkey" PRIMARY KEY ("tenantId","workflowKey","nodeId")
);
