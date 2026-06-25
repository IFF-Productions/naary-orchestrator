-- CreateTable
CREATE TABLE "TenantBudget" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "monthlyCapUsd" DECIMAL(12,2) NOT NULL,
    "perExecutionCapUsd" DECIMAL(12,2) NOT NULL,
    "maxStepsPerRun" INTEGER NOT NULL DEFAULT 50,
    "onBudgetExceeded" TEXT NOT NULL DEFAULT 'reject',
    "fallbackModel" TEXT,

    CONSTRAINT "TenantBudget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantBudget_tenantId_key" ON "TenantBudget"("tenantId");
