-- #1078 §2 shape B (slice 3): the `naary auth` device-code handshake.
--
-- A WHOLE NEW TABLE, so it is unconditionally expand-safe under a rolling deploy (docker-rollout):
-- the old API image does not know it exists and never reads or writes it, and the new image is its
-- only reader and writer. Nothing to backfill, nothing the two images can disagree about.
--
-- `deviceCodeHash` is UNIQUE because it is the lookup key (sha256 of the plaintext, which is never
-- stored). `userCode` is UNIQUE because it is what a human types to find their own pending request —
-- two live requests sharing one code would let a user approve someone else's login by accident.
-- `expiresAt` is indexed for the eventual sweep of dead handshakes; no hot path uses it.
-- No FK on tenantId/userId: neither has a table in this schema (cf. ApiToken, CliRefreshToken).
CREATE TABLE "CliAuthRequest" (
    "id" TEXT NOT NULL,
    "deviceCodeHash" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "tenantId" TEXT,
    "userId" TEXT,
    "deniedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "CliAuthRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CliAuthRequest_deviceCodeHash_key" ON "CliAuthRequest"("deviceCodeHash");

CREATE UNIQUE INDEX "CliAuthRequest_userCode_key" ON "CliAuthRequest"("userCode");

CREATE INDEX "CliAuthRequest_expiresAt_idx" ON "CliAuthRequest"("expiresAt");
