-- Conversational AI builder (AI-BUILDER-CONVERSATION.md): persisted, resumable build sessions +
-- their conversation turns. Additive (expand-safe): new tables, no FK into existing ones.
CREATE TABLE "BuilderSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "environmentId" TEXT,
    "workflowKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "closedReason" TEXT,
    "currentGraph" JSONB,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "BuilderSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BuilderSession_tenantId_status_updatedAt_idx" ON "BuilderSession"("tenantId", "status", "updatedAt");

CREATE TABLE "BuilderTurn" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "costUsd" DECIMAL(12,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuilderTurn_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BuilderTurn_sessionId_createdAt_idx" ON "BuilderTurn"("sessionId", "createdAt");

ALTER TABLE "BuilderTurn" ADD CONSTRAINT "BuilderTurn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "BuilderSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
