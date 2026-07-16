-- CreateTable
CREATE TABLE "Variable" (
    "tenantId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Variable_pkey" PRIMARY KEY ("tenantId","environmentId","key")
);

-- CreateIndex
CREATE INDEX "Variable_tenantId_environmentId_idx" ON "Variable"("tenantId", "environmentId");

-- AddForeignKey
ALTER TABLE "Variable" ADD CONSTRAINT "Variable_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
