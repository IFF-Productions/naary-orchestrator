-- CreateTable
CREATE TABLE "TurnstileConfig" (
    "tenantId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "siteKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TurnstileConfig_pkey" PRIMARY KEY ("tenantId","environmentId")
);

-- CreateIndex
CREATE INDEX "TurnstileConfig_tenantId_environmentId_idx" ON "TurnstileConfig"("tenantId", "environmentId");

-- AddForeignKey
ALTER TABLE "TurnstileConfig" ADD CONSTRAINT "TurnstileConfig_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
