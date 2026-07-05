import { Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";

export interface NotificationSettingsView {
  webhookUrl: string | null;
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
      onApprovalPending: row?.onApprovalPending ?? true,
      onRunFailed: row?.onRunFailed ?? true,
    };
  }

  async save(
    tenantId: string,
    patch: {
      webhookUrl?: string | null;
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
        onApprovalPending: patch.onApprovalPending ?? true,
        onRunFailed: patch.onRunFailed ?? true,
      },
      update: {
        webhookUrl,
        onApprovalPending: patch.onApprovalPending,
        onRunFailed: patch.onRunFailed,
      },
    });
    return {
      webhookUrl: row.webhookUrl,
      onApprovalPending: row.onApprovalPending,
      onRunFailed: row.onRunFailed,
    };
  }
}
