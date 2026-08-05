-- #1078 §5: the device hint the Settings CLI-session list shows.
--
-- EXPAND-ONLY and safe under a rolling deploy (docker-rollout): a NULLABLE column with no default,
-- so the old API image — which never names columns on insert, it goes through Prisma's generated
-- client for the columns it knows — keeps writing rows that simply have no label, and the new image
-- renders those as "Unknown device". Nothing backfills, because the label is the hostname a CLI
-- reported at a login that has already happened; inventing one for an existing row would be a
-- fabricated device name on a security screen.
ALTER TABLE "CliRefreshToken" ADD COLUMN "label" TEXT;
