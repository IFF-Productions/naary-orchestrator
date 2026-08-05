-- #1078 slice 3 follow-up (the residual #1118 documented on `CliAuthController.refresh`): make a
-- CLI-minted `nry_` access token attributable to the human it was minted for, so removing or
-- demoting that member can DELETE it instead of waiting out its 12h `expiresAt`.
--
-- NULLABLE with NO default, on purpose — the same grandfathering posture as `expiresAt` above.
-- NULL means "not a person's CLI session": every Settings-created and CI token keeps working
-- untouched, and every token minted before this column existed reads NULL, which is the correct
-- answer rather than a gap. There is nothing to backfill it TO, so there is no backfill. Only
-- `/auth/cli/exchange` and `/auth/cli/refresh` ever write it.
--
-- EXPAND-ONLY, safe under a rolling deploy (docker-rollout): the old API image does not select or
-- write the column and authenticates tokens exactly as it does today; the new image reads NULL on
-- every existing row and treats it as "unowned", which is also exactly today's behaviour. Old and
-- new can run side by side.
--
-- THE ONE ASYMMETRY `expiresAt` DID NOT HAVE, stated rather than left implicit: while both images
-- are live, a CLI login served by the OLD image mints an access token with `userId = NULL`, so
-- that particular token stays unrevocable by member removal. Bounded and self-healing — it dies at
-- its 12h TTL, or sooner when the session's next refresh lands on the new image and mints an owned
-- successor — and it is strictly no worse than the pre-migration state it reproduces.
ALTER TABLE "ApiToken" ADD COLUMN "userId" TEXT;

-- The offboarding read ("this user's CLI tokens in THIS workspace"). Tenant-first so it also
-- serves the existing tenant-only lookups. Not created CONCURRENTLY: Prisma Migrate runs each
-- migration in a transaction, and this index is on a table that is a handful of rows per tenant.
CREATE INDEX "ApiToken_tenantId_userId_idx" ON "ApiToken"("tenantId", "userId");
