-- N webhooks per channel type (Slack, Teams): drop the one-config-per-type constraint and
-- add a user-facing label + createdAt for stable ordering. Existing rows are untouched —
-- each becomes the first channel of its type. Expand/contract safe: old code's
-- (tenantId, type) lookups still work as plain filters.
-- DropIndex
DROP INDEX "NotificationChannel_tenantId_type_key";

-- AlterTable
ALTER TABLE "NotificationChannel" ADD COLUMN "label" TEXT;
ALTER TABLE "NotificationChannel" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
