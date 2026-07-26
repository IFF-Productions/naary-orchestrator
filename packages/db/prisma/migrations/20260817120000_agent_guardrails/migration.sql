-- Agent guardrails (#576): per-workspace governance policy on the existing settings row.
-- EXPAND-only (nullable, no default, no backfill) so a rolling deploy is safe in both
-- directions — an old api/worker simply never reads the column.
ALTER TABLE "TenantSettings" ADD COLUMN "agentGuardrails" JSONB;
