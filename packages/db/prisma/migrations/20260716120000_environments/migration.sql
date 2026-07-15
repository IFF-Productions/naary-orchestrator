-- Per-tenant environments (design docs/design/ENVIRONMENTS.md), Slice 1: the entity only.
-- No env-scoping of other tables yet (that lands incrementally behind a default-env shim), so this
-- is purely additive. The default "Production" env per tenant is created LAZILY by the service
-- (upsert on the unique slug — race-safe), so there's no data backfill here.

-- CreateTable
CREATE TABLE "Environment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Environment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Environment_tenantId_slug_key" ON "Environment"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "Environment_tenantId_idx" ON "Environment"("tenantId");
