-- Per-channel notifications: replace the single-row/either-or NotificationSettings
-- (one webhookUrl + a "slack" | "teams" discriminator) with one row per (tenant, channel
-- type), each independently enabled + configured. ADDITIVE: NotificationSettings is left
-- in place (dropped in a later migration) so an old worker replica mid-rolling-deploy still
-- reads it. We backfill every existing setting into a NotificationChannel row first.

-- CreateTable
CREATE TABLE "NotificationChannel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "webhookUrl" TEXT,
    "config" JSONB,
    "onApprovalPending" BOOLEAN NOT NULL DEFAULT true,
    "onRunFailed" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationChannel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationChannel_tenantId_type_key" ON "NotificationChannel"("tenantId", "type");

-- CreateIndex
CREATE INDEX "NotificationChannel_tenantId_idx" ON "NotificationChannel"("tenantId");

-- Backfill from NotificationSettings, preserving prior behavior EXACTLY:
--   * type            = the old `channel` (normalized: anything not "teams" → "slack")
--   * enabled         = derived from URL presence — a row that WAS sending (webhookUrl set)
--                       stays enabled; a row with no URL wasn't sending → enabled=false.
--                       (NOT the column default `true`, which would silently "enable" an
--                       unconfigured tenant.)
--   * event flags     = carried over verbatim.
-- gen_random_uuid() needs pgcrypto (present on the target); use it for the standalone id.
INSERT INTO "NotificationChannel"
    ("id", "tenantId", "type", "enabled", "webhookUrl", "onApprovalPending", "onRunFailed", "updatedAt")
SELECT
    gen_random_uuid(),
    "tenantId",
    CASE WHEN "channel" = 'teams' THEN 'teams' ELSE 'slack' END,
    ("webhookUrl" IS NOT NULL AND "webhookUrl" <> ''),
    "webhookUrl",
    "onApprovalPending",
    "onRunFailed",
    "updatedAt"
FROM "NotificationSettings"
ON CONFLICT ("tenantId", "type") DO NOTHING;
