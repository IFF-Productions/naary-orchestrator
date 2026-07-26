-- SAML SSO connection: one enterprise IdP mapped to one workspace (#455).
-- Additive only (expand/contract-safe: no existing column is touched, so an older
-- app version keeps running against this schema).
CREATE TABLE "SsoConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT,
    "idpEntityId" TEXT NOT NULL,
    "idpSsoUrl" TEXT NOT NULL,
    "idpCertPem" TEXT NOT NULL,
    "allowedEmailDomains" TEXT[],
    "defaultRole" TEXT NOT NULL DEFAULT 'member',
    "autoProvision" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SsoConnection_pkey" PRIMARY KEY ("id")
);

-- A slug addresses exactly one connection…
CREATE UNIQUE INDEX "SsoConnection_slug_key" ON "SsoConnection"("slug");
-- …and an IdP entity id maps to exactly ONE workspace instance-wide: this uniqueness IS
-- the guarantee that a validly-signed assertion is never ambiguous about its tenant.
CREATE UNIQUE INDEX "SsoConnection_idpEntityId_key" ON "SsoConnection"("idpEntityId");
CREATE INDEX "SsoConnection_tenantId_idx" ON "SsoConnection"("tenantId");
