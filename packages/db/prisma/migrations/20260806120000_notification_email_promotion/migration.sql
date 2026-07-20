-- Slice 4 (REDESIGN-FUNCTIONALITY-GAPS.md) — email notification channel + onPromotion event.
-- EXPAND-ONLY: one defaulted boolean, no backfill, no drops. The email channel type itself
-- needs NO schema change ("type" is a free string column and "config" Json already exists —
-- email rows store { connectionId, to[] } there; SMTP credentials stay in the encrypted
-- credential store keyed by the connection, never in this table).

-- NotificationChannel: per-channel opt-in for the promotion event (a workflow promoted INTO
-- this channel's environment). Default false — never surprise-enabled on an existing channel.
ALTER TABLE "NotificationChannel" ADD COLUMN "onPromotion" BOOLEAN NOT NULL DEFAULT false;
