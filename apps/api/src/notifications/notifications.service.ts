import { BadRequestException, Injectable } from "@nestjs/common";
import {
  assertEgressAllowed,
  BlockedEgressError,
  safeFetch,
} from "@naary/connections";
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

  /**
   * Send a one-off TEST message to the configured webhook so the user can confirm — from
   * their own Slack/Teams channel — that the URL works and the format renders. Unlike the
   * worker's fire-and-forget sendNotification, this reports the outcome: it egress-guards
   * the URL (SSRF: https + public only) and surfaces a non-2xx / unreachable webhook as a
   * 400 the UI can show. This is the real verification path for the Teams integration
   * (a mocked test can't prove Teams accepts the Adaptive Card).
   */
  async sendTest(tenantId: string): Promise<{ ok: true; status: number }> {
    const settings = await this.get(tenantId);
    if (!settings.webhookUrl) {
      throw new BadRequestException(
        "No webhook URL configured — save one first.",
      );
    }
    // Fail fast on a private/non-https target before opening a socket.
    try {
      await assertEgressAllowed(settings.webhookUrl);
    } catch (e) {
      if (e instanceof BlockedEgressError) {
        throw new BadRequestException(
          `That webhook URL isn't allowed (${e.message}) — it must be a public https URL.`,
        );
      }
      throw e;
    }

    const payload =
      settings.channel === "teams" ? teamsTestCard() : slackTestPayload();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let res: { ok: boolean; status: number };
    try {
      res = (await safeFetch(settings.webhookUrl, {
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
          settings.channel === "teams"
            ? " (for Teams, it must be a Workflows webhook)"
            : ""
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
