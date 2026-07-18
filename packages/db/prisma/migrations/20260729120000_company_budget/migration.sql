-- CreateTable
CREATE TABLE "CompanyBudget" (
    "companyId" TEXT NOT NULL,
    "monthlyCapUsd" DECIMAL(12,2) NOT NULL,
    "onBudgetExceeded" TEXT NOT NULL DEFAULT 'reject',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyBudget_pkey" PRIMARY KEY ("companyId")
);

-- AddForeignKey
ALTER TABLE "CompanyBudget" ADD CONSTRAINT "CompanyBudget_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
