-- Tenant-wide ($secrets) secrets (#459): named secrets that apply to EVERY environment. Separate
-- table (not a null-env TenantCredential) so the env FK/unique on TenantCredential stays intact.
-- CreateTable
CREATE TABLE "TenantSecret" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantSecret_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantSecret_tenantId_key_key" ON "TenantSecret"("tenantId", "key");
