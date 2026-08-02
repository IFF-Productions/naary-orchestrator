-- #1060: mark a UsageEvent whose TOKEN COUNTS are the Tier-1 rule-6 fallback estimate rather than
-- a provider-reported measurement.
--
-- EXPAND-ONLY, safe under a rolling deploy (docker-rollout): the column is added with a DEFAULT, so
-- the old worker image — which does not know the column exists — keeps inserting rows that are
-- valid. No backfill: existing rows correctly read as "not known to be estimated", which is exactly
-- what they are, and there is no surviving signal that could tell us otherwise (the estimate/measured
-- distinction lived on sampled, short-retention spans).
ALTER TABLE "UsageEvent" ADD COLUMN "estimated" BOOLEAN NOT NULL DEFAULT false;
