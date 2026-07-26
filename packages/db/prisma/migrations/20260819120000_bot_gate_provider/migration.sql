-- Which bot gate guards a tenant/env's public form+chat pages: the tenant's own Cloudflare
-- Turnstile keys, or the platform's Firebase App Check (no tenant keys).
-- See docs/design/TENANT-BOT-GATE-PROVIDERS.md.
--
-- EXPAND/CONTRACT SAFE: additive and DEFAULTed, so every existing row reads as 'turnstile'
-- (its current behaviour, unchanged) and an older API image simply ignores the column. No
-- backfill needed and nothing to contract later.
ALTER TABLE "TurnstileConfig" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'turnstile';
