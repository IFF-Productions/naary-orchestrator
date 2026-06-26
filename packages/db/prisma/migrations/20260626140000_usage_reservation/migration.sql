-- CreateTable
CREATE TABLE "UsageReservation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "estimatedCostUsd" DECIMAL(12,6) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsageReservation_tenantId_createdAt_idx" ON "UsageReservation"("tenantId", "createdAt");

