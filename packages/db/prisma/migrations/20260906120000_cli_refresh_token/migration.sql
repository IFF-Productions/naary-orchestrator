-- #1078 §4 (slice 2): rotating refresh tokens for `naary auth`.
--
-- A WHOLE NEW TABLE, which is unconditionally expand-safe under a rolling deploy (docker-rollout):
-- the old API image does not know this table exists and never reads or writes it, and the new image
-- is its only reader and writer. There is nothing for the two to disagree about, so this needs no
-- backfill and no nullable-column argument — old and new can run side by side indefinitely.
--
-- `tokenHash` is UNIQUE because it is the lookup key (sha256 of the plaintext, which is never
-- stored). `familyId` is indexed because reuse detection revokes a whole lineage in one statement,
-- and (tenantId, userId) because listing/revoking a user's CLI sessions is the other read path.
-- No FK on tenantId/userId: neither has a table in this schema (cf. ApiToken, Membership).
CREATE TABLE "CliRefreshToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "CliRefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CliRefreshToken_tokenHash_key" ON "CliRefreshToken"("tokenHash");

CREATE INDEX "CliRefreshToken_familyId_idx" ON "CliRefreshToken"("familyId");

CREATE INDEX "CliRefreshToken_tenantId_userId_idx" ON "CliRefreshToken"("tenantId", "userId");
