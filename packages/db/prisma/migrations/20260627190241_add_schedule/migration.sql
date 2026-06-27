-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Schedule_tenantId_idx" ON "Schedule"("tenantId");
