import { BadRequestException, Injectable } from "@nestjs/common";
import {
  assertEgressAllowed,
  BlockedEgressError,
  safeFetch,
} from "@naary/connections";
import { getPrisma } from "@naary/db";

/** Channel types the product ships today. Each is configured + toggled INDEPENDENTLY
 *  (not the old either/or). `email` and others slot in here later without a schema change. */
export const NOTIFICATION_CHANNEL_TYPES = ["slack", "teams"] as const;
export type NotificationChannelType =
  (typeof NOTIFICATION_CHANNEL_TYPES)[number];

function isChannelType(v: string): v is NotificationChannelType {
  return (NOTIFICATION_CHANNEL_TYPES as readonly string[]).includes(v);
}

/** One independently-configurable channel for a tenant. */
export interface NotificationChannelView {
  type: NotificationChannelType;
  /** Off = the worker skips this channel entirely, even with a URL set. */
  enabled: boolean;
  webhookUrl: string | null;
  onApprovalPending: boolean;
  onRunFailed: boolean;
}

export interface SaveChannelPatch {
  enabled?: boolean;
  webhookUrl?: string | null;
  onApprovalPending?: boolean;
  onRunFailed?: boolean;
}

/**
 * Per-tenant notification channels — Slack, Teams (and later email) each configured and toggled
 * on their own, so an alert fans out to every enabled channel rather than one either/or webhook.
 * A channel with no saved row reports its defaults (disabled, no URL, both events on) so the UI
 * can render all known channels uniformly.
 */
@Injectable()
export class NotificationsService {
  /** Every known channel type for the tenant, saved-or-default, in a stable order. */
  async list(tenantId: string): Promise<NotificationChannelView[]> {
    const rows = await getPrisma().notificationChannel.findMany({
      where: { tenantId },
    });
    const byType = new Map(rows.map((r) => [r.type, r]));
    return NOTIFICATION_CHANNEL_TYPES.map((type) => {
      const row = byType.get(type);
      return {
        type,
        // No row yet → disabled (an unconfigured channel never sends).
        enabled: row?.enabled ?? false,
        webhookUrl: row?.webhookUrl ?? null,
        onApprovalPending: row?.onApprovalPending ?? true,
        onRunFailed: row?.onRunFailed ?? true,
      };
    });
  }

  private async getChannel(
    tenantId: string,
    type: NotificationChannelType,
  ): Promise<NotificationChannelView> {
    const row = await getPrisma().notificationChannel.findUnique({
      where: { tenantId_type: { tenantId, type } },
    });
    return {
      type,
      enabled: row?.enabled ?? false,
      webhookUrl: row?.webhookUrl ?? null,
      onApprovalPending: row?.onApprovalPending ?? true,
      onRunFailed: row?.onRunFailed ?? true,
    };
  }

  /** Upsert ONE channel's config (identified by type). Other channels are untouched. */
  async saveChannel(
    tenantId: string,
    type: string,
    patch: SaveChannelPatch,
  ): Promise<NotificationChannelView> {
    if (!isChannelType(type)) {
      throw new BadRequestException(`Unknown notification channel '${type}'.`);
    }
    // Normalize a blank URL to null (clears the target).
    const webhookUrl =
      patch.webhookUrl === undefined
        ? undefined
        : patch.webhookUrl?.trim() || null;
    const row = await getPrisma().notificationChannel.upsert({
      where: { tenantId_type: { tenantId, type } },
      create: {
        tenantId,
        type,
        enabled: patch.enabled ?? false,
        webhookUrl: webhookUrl ?? null,
        onApprovalPending: patch.onApprovalPending ?? true,
        onRunFailed: patch.onRunFailed ?? true,
      },
      update: {
        enabled: patch.enabled,
        webhookUrl,
        onApprovalPending: patch.onApprovalPending,
        onRunFailed: patch.onRunFailed,
      },
    });
    return {
      type,
      enabled: row.enabled,
      webhookUrl: row.webhookUrl,
      onApprovalPending: row.onApprovalPending,
      onRunFailed: row.onRunFailed,
    };
  }

  /** Remove a channel's config entirely (idempotent — deleting an unconfigured channel is a no-op). */
  async deleteChannel(tenantId: string, type: string): Promise<void> {
    if (!isChannelType(type)) {
      throw new BadRequestException(`Unknown notification channel '${type}'.`);
    }
    await getPrisma().notificationChannel.deleteMany({
      where: { tenantId, type },
    });
  }

  /**
   * Send a one-off TEST message to ONE channel's webhook so the user can confirm — from their own
   * Slack/Teams channel — that the URL works and the format renders. Unlike the worker's
   * fire-and-forget fan-out, this reports the outcome: it egress-guards the URL (SSRF: https +
   * public only) and surfaces a non-2xx / unreachable webhook as a 400 the UI can show. This is
   * the real verification path for the Teams integration (a mocked test can't prove Teams accepts
   * the Adaptive Card).
   */
  async sendTest(
    tenantId: string,
    type: string,
  ): Promise<{ ok: true; status: number }> {
    if (!isChannelType(type)) {
      throw new BadRequestException(`Unknown notification channel '${type}'.`);
    }
    const channel = await this.getChannel(tenantId, type);
    if (!channel.webhookUrl) {
      throw new BadRequestException(
        `No webhook URL configured for ${type} — save one first.`,
      );
    }
    // Fail fast on a private/non-https target before opening a socket.
    try {
      await assertEgressAllowed(channel.webhookUrl);
    } catch (e) {
      if (e instanceof BlockedEgressError) {
        throw new BadRequestException(
          `That webhook URL isn't allowed (${e.message}) — it must be a public https URL.`,
        );
      }
      throw e;
    }

    const payload = type === "teams" ? teamsTestCard() : slackTestPayload();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let res: { ok: boolean; status: number };
    try {
      res = (await safeFetch(channel.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })) as unknown as { ok: boolean; status: number };
    } catch (e) {
      if (e instanceof BlockedEgressError) {
        throw new BadRequestException(
          `That webhook URL isn't allowed (${e.message}).`,
        );
      }
      throw new BadRequestException(
        "Couldn't reach the webhook (timeout or network error). Check the URL.",
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new BadRequestException(
        `The webhook responded ${res.status}. Check the URL${
          type === "teams" ? " (for Teams, it must be a Workflows webhook)" : ""
        }.`,
      );
    }
    return { ok: true, status: res.status };
  }
}

/** Minimal Slack test payload — a header + one line. Enough to confirm delivery + rendering. */
function slackTestPayload(): unknown {
  return {
    text: "🔔 Test notification from Naary — your webhook is configured correctly.",
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "🔔 Test notification", emoji: true },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Your Naary webhook is configured correctly. Real alerts (approvals, run failures) will arrive here.",
        },
      },
    ],
  };
}

/** Minimal Teams Adaptive Card test payload in the {type:"message",attachments:[…]} envelope. */
function teamsTestCard(): unknown {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.2",
          body: [
            {
              type: "TextBlock",
              text: "🔔 Test notification",
              weight: "Bolder",
              size: "Large",
              wrap: true,
            },
            {
              type: "TextBlock",
              text: "Your Naary webhook is configured correctly. Real alerts (approvals, run failures) will arrive here.",
              wrap: true,
            },
          ],
        },
      },
    ],
  };
}
