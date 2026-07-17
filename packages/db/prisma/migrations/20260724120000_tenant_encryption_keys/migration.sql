-- Per-tenant data-encryption keys (DEKs), wrapped by the master ENCRYPTION_KEY (envelope
-- encryption). Additive + expand/contract safe: old code never reads this table; new code
-- mints rows lazily and keeps decrypting keyVersion 1/2 TenantCredential rows with the
-- master key.
-- CreateTable
CREATE TABLE "TenantKey" (
    "tenantId" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantKey_pkey" PRIMARY KEY ("tenantId")
);
