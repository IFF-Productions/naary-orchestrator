-- #1075 slice 1: SCIM 2.0 read surface — the connection credential and the stable resource id.
--
-- EXPAND-ONLY, safe under a rolling deploy (docker-rollout): two brand-new tables and no change
-- to any existing one, so the old API image is entirely unaffected — it neither reads nor writes
-- these, and nothing it does writes becomes invalid. There is no contract phase to follow.
--
-- No backfill of ScimIdentity: rows are materialised lazily on the first SCIM read (see
-- ScimUsersService), because a backfill would have to guess which workspaces will ever connect
-- an IdP and would write a row for every member of every workspace that never does.

CREATE TABLE "ScimConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "allowedEmailDomains" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "ScimConnection_pkey" PRIMARY KEY ("id")
);

-- The token lookup is BY HASH, so this unique index is also the hot path for every SCIM request.
CREATE UNIQUE INDEX "ScimConnection_tokenHash_key" ON "ScimConnection"("tokenHash");
CREATE INDEX "ScimConnection_tenantId_idx" ON "ScimConnection"("tenantId");

CREATE TABLE "ScimIdentity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "userId" TEXT,
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScimIdentity_pkey" PRIMARY KEY ("id")
);

-- (tenantId, email) is the materialisation key: one directory subject per workspace, and the
-- unique constraint is what makes the lazy upsert safe under concurrent reconcile GETs.
CREATE UNIQUE INDEX "ScimIdentity_tenantId_email_key" ON "ScimIdentity"("tenantId", "email");
CREATE INDEX "ScimIdentity_tenantId_idx" ON "ScimIdentity"("tenantId");
CREATE INDEX "ScimIdentity_tenantId_externalId_idx" ON "ScimIdentity"("tenantId", "externalId");
