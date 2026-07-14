import { Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";

export type NotificationChannel = "slack" | "teams";

/** Any unknown/legacy value falls back to "slack" (the default format). */
function normalizeChannel(v: string | null | undefined): NotificationChannel {
  return v === "teams" ? "teams" : "slack";
}

export interface NotificationSettingsView {
  webhookUrl: string | null;
  /** Payload format posted to webhookUrl: Slack Block Kit or a Teams Adaptive Card. */
  channel: NotificationChannel;
  onApprovalPending: boolean;
  onRunFailed: boolean;
}

/** Per-tenant notification settings (one row per tenant). Defaults when unset:
 *  no webhook, both event types enabled (so setting a URL is all it takes). */
@Injectable()
export class NotificationsService {
  async get(tenantId: string): Promise<NotificationSettingsView> {
    const row = await getPrisma().notificationSettings.findUnique({
      where: { tenantId },
    });
    return {
      webhookUrl: row?.webhookUrl ?? null,
      channel: normalizeChannel(row?.channel),
      onApprovalPending: row?.onApprovalPending ?? true,
      onRunFailed: row?.onRunFailed ?? true,
    };
  }

  async save(
    tenantId: string,
    patch: {
      webhookUrl?: string | null;
      channel?: NotificationChannel;
      onApprovalPending?: boolean;
      onRunFailed?: boolean;
    },
  ): Promise<NotificationSettingsView> {
    // Normalize a blank URL to null (turns notifications off).
    const webhookUrl =
      patch.webhookUrl === undefined
        ? undefined
        : patch.webhookUrl?.trim() || null;
    const row = await getPrisma().notificationSettings.upsert({
      where: { tenantId },
      create: {
        tenantId,
        webhookUrl: webhookUrl ?? null,
        channel: patch.channel ?? "slack",
        onApprovalPending: patch.onApprovalPending ?? true,
        onRunFailed: patch.onRunFailed ?? true,
      },
      update: {
        webhookUrl,
        channel: patch.channel,
        onApprovalPending: patch.onApprovalPending,
        onRunFailed: patch.onRunFailed,
      },
    });
    return {
      webhookUrl: row.webhookUrl,
      channel: normalizeChannel(row.channel),
      onApprovalPending: row.onApprovalPending,
      onRunFailed: row.onRunFailed,
    };
  }
}
