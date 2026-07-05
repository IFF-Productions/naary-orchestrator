-- CreateTable
CREATE TABLE "NotificationSettings" (
    "tenantId" TEXT NOT NULL,
    "webhookUrl" TEXT,
    "onApprovalPending" BOOLEAN NOT NULL DEFAULT true,
    "onRunFailed" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationSettings_pkey" PRIMARY KEY ("tenantId")
);
