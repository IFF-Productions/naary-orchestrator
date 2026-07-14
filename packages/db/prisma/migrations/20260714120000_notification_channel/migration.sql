-- Notification channel: which payload format to POST to the tenant's webhook.
-- "slack" (default) = Slack Block Kit; "teams" = an Adaptive Card envelope a Teams
-- Workflows/Incoming-Webhook renders. Additive with a default so existing rows stay Slack.

ALTER TABLE "NotificationSettings" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'slack';
