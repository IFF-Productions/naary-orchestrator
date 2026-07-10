-- Deterministic ordering for chat memory: a monotonic BIGSERIAL `seq` gives a total
-- insertion order so two rows sharing a millisecond `createdAt` still sort deterministically
-- (review follow-up to the ChatMessage table). Swap the (…, createdAt) index for (…, seq),
-- which is what loadHistory now orders by.

-- AddColumn (BIGSERIAL backfills existing rows in insertion order)
ALTER TABLE "ChatMessage" ADD COLUMN "seq" BIGSERIAL NOT NULL;

-- Re-point the covering index at `seq`
DROP INDEX IF EXISTS "ChatMessage_tenantId_chatId_sessionId_createdAt_idx";
CREATE INDEX "ChatMessage_tenantId_chatId_sessionId_seq_idx" ON "ChatMessage"("tenantId", "chatId", "sessionId", "seq");
