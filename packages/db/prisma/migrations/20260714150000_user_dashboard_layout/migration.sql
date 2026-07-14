-- Customizable Overview layout, stored per-user: an ordered array of
-- { id, hidden, span } widget entries. NULL = never customized (client default).
-- Additive nullable JSON column — no rewrite, existing rows unaffected.

ALTER TABLE "UserPreference" ADD COLUMN "dashboard" JSONB;
