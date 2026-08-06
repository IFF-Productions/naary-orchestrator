-- #1078 §5 follow-up: make a CLI-minted `nry_` access token attributable to the SESSION (rotation
-- family) it belongs to, so "Sign out this device" in Settings can DELETE it instead of leaving it
-- authenticating for up to 12 more hours.
--
-- #1122 added `userId` and closed the OFFBOARDING window: removing or demoting a member deletes
-- every CLI access token they hold in that workspace. It cannot close this one — a user with three
-- laptops who signs out one of them must keep the other two, and `userId` cannot tell them apart.
-- `familyId` is that missing distinction, and it is the id `CliRefreshToken` already groups by.
--
-- NULLABLE with NO default and NO backfill, the same grandfathering posture as `userId` and
-- `expiresAt` before it. NULL means "not part of a CLI rotation family": every Settings-created and
-- CI token keeps working untouched (they are workspace capabilities, and no session revoke may
-- reach them), and every CLI token minted before this column existed reads NULL, which is the
-- correct answer rather than a gap — there is nothing to backfill it TO.
--
-- EXPAND-ONLY, safe under a rolling deploy (docker-rollout): the old API image neither selects nor
-- writes the column and authenticates tokens exactly as it does today; the new image reads NULL on
-- every existing row and treats it as "no session", which is also exactly today's behaviour.
--
-- THE BOUNDED RESIDUAL, stated rather than left implicit — the same one `userId` has: a CLI token
-- minted before this migration (or by the OLD image mid-rollout) carries no family, so revoking its
-- session does not recall it. It dies at its own ≤12h `expiresAt`, and sooner in practice: the
-- session's next refresh mints a successor that DOES carry the id, and a revoked family cannot
-- refresh at all. Strictly no worse than the pre-migration state it reproduces.
ALTER TABLE "ApiToken" ADD COLUMN "familyId" TEXT;

-- The per-session revoke read ("this device's access token in THIS workspace"). Tenant-first, like
-- the (tenantId, userId) index above, so it also serves the plain tenant lookups. Not CONCURRENTLY:
-- Prisma Migrate runs each migration in a transaction, and this table is a handful of rows/tenant.
CREATE INDEX "ApiToken_tenantId_familyId_idx" ON "ApiToken"("tenantId", "familyId");
