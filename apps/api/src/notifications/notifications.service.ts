import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  assertEgressAllowed,
  BlockedEgressError,
  safeFetch,
} from "@naary/connections";
import { getPrisma } from "@naary/db";
import { notificationPayload } from "@naary/notifications";
import { approvalPath } from "../executions/approval-token";

/** Channel types the product ships today. A tenant may have ANY NUMBER of channels per
 *  type (N Slack + N Teams webhooks); `email` and others slot in here later without a
 *  schema change. */
export const NOTIFICATION_CHANNEL_TYPES = ["slack", "teams"] as const;
export type NotificationChannelType =
  (typeof NOTIFICATION_CHANNEL_TYPES)[number];

/** Per-environment channel cap — plenty for real fan-out, a backstop against abuse (each
 *  enabled row is an outbound POST per event). */
export const MAX_CHANNELS_PER_ENV = 20;

function isChannelType(v: string): v is NotificationChannelType {
  return (NOTIFICATION_CHANNEL_TYPES as readonly string[]).includes(v);
}

/** One notification channel row — addressed by `id` (a tenant can have several per type). */
export interface NotificationChannelView {
  id: string;
  type: NotificationChannelType;
  /** User-facing name distinguishing same-type channels (e.g. "#alerts"). Null = unnamed. */
  label: string | null;
  /** Off = the worker skips this channel entirely, even with a URL set. */
  enabled: boolean;
  webhookUrl: string | null;
  onApprovalPending: boolean;
  onRunFailed: boolean;
  /** Budget alert-threshold opt-in (Slice 3). Default false — never surprise-enabled. */
  onBudgetThreshold: boolean;
}

export interface ChannelPatch {
  label?: string | null;
  enabled?: boolean;
  webhookUrl?: string | null;
  onApprovalPending?: boolean;
  onRunFailed?: boolean;
  onBudgetThreshold?: boolean;
}

interface ChannelRow {
  id: string;
  type: string;
  label: string | null;
  enabled: boolean;
  webhookUrl: string | null;
  onApprovalPending: boolean;
  onRunFailed: boolean;
  onBudgetThreshold: boolean;
}

function toView(row: ChannelRow): NotificationChannelView {
  return {
    id: row.id,
    type: row.type as NotificationChannelType,
    label: row.label,
    enabled: row.enabled,
    webhookUrl: row.webhookUrl,
    onApprovalPending: row.onApprovalPending,
    onRunFailed: row.onRunFailed,
    onBudgetThreshold: row.onBudgetThreshold,
  };
}

/** Blank strings normalize to null (clears the value). Undefined = leave unchanged. */
function normalize(v: string | null | undefined): string | null | undefined {
  return v === undefined ? undefined : v?.trim() || null;
}

/**
 * Per-environment notification channels — any number of Slack/Teams webhooks (e.g. #alerts
 * AND #oncall), each configured and toggled on its own. An alert fans out to EVERY enabled
 * channel of the RUN'S environment whose event toggle is on (Slice 6b: a sandbox failure
 * must not page prod's Slack). Channels are addressed by row id; `label` tells same-type
 * channels apart in the UI. `environmentId` arrives RESOLVED (controller boundary calls
 * resolveEnvId), matching the pins/graphs pattern.
 */
@Injectable()
export class NotificationsService {
  /** The env's channels, in a stable order (type, then creation order). */
  async list(
    tenantId: string,
    environmentId: string,
  ): Promise<NotificationChannelView[]> {
    const rows = await getPrisma().notificationChannel.findMany({
      where: { tenantId, environmentId },
      orderBy: [{ type: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map(toView);
  }

  /** Create a new channel of the given type in this env. Enabled by default — creating one
   *  is an explicit user action, unlike the old implicit per-type rows. */
  async createChannel(
    tenantId: string,
    environmentId: string,
    type: string,
    patch: ChannelPatch,
  ): Promise<NotificationChannelView> {
    if (!isChannelType(type)) {
      throw new BadRequestException(`Unknown notification channel '${type}'.`);
    }
    const count = await getPrisma().notificationChannel.count({
      where: { tenantId, environmentId },
    });
    if (count >= MAX_CHANNELS_PER_ENV) {
      throw new BadRequestException(
        `Channel limit reached (${MAX_CHANNELS_PER_ENV}). Delete one before adding another.`,
      );
    }
    const row = await getPrisma().notificationChannel.create({
      data: {
        tenantId,
        environmentId,
        type,
        label: normalize(patch.label) ?? null,
        enabled: patch.enabled ?? true,
        webhookUrl: normalize(patch.webhookUrl) ?? null,
        onApprovalPending: patch.onApprovalPending ?? true,
        onRunFailed: patch.onRunFailed ?? true,
        // Budget alerts are opt-in (Slice 3): default OFF even on a fresh channel.
        onBudgetThreshold: patch.onBudgetThreshold ?? false,
      },
    });
    return toView(row);
  }

  /** Update ONE channel by id (tenant+env-scoped — can't touch another tenant's or another
   *  env's). 404 if absent. */
  async updateChannel(
    tenantId: string,
    environmentId: string,
    channelId: string,
    patch: ChannelPatch,
  ): Promise<NotificationChannelView> {
    // Scoped existence check first: `update` alone would key on the global id.
    const existing = await getPrisma().notificationChannel.findFirst({
      where: { id: channelId, tenantId, environmentId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException("Unknown notification channel.");
    }
    const row = await getPrisma().notificationChannel.update({
      where: { id: channelId },
      data: {
        label: normalize(patch.label),
        enabled: patch.enabled,
        webhookUrl: normalize(patch.webhookUrl),
        onApprovalPending: patch.onApprovalPending,
        onRunFailed: patch.onRunFailed,
        onBudgetThreshold: patch.onBudgetThreshold,
      },
    });
    return toView(row);
  }

  /** Delete ONE channel by id (tenant+env-scoped; idempotent). */
  async deleteChannel(
    tenantId: string,
    environmentId: string,
    channelId: string,
  ): Promise<void> {
    await getPrisma().notificationChannel.deleteMany({
      where: { id: channelId, tenantId, environmentId },
    });
  }

  /**
   * Send a one-off TEST message to ONE channel's webhook so the user can confirm — from their
   * own Slack/Teams channel — that the URL works and the format renders. Unlike the worker's
   * fire-and-forget fan-out, this reports the outcome: it egress-guards the URL (SSRF: https +
   * public only) and surfaces a non-2xx / unreachable webhook as a 400 the UI can show. This is
   * the real verification path for the Teams integration (a mocked test can't prove Teams
   * accepts the Adaptive Card).
   */
  async sendTest(
    tenantId: string,
    environmentId: string,
    channelId: string,
  ): Promise<{ ok: true; status: number }> {
    const row = await getPrisma().notificationChannel.findFirst({
      where: { id: channelId, tenantId, environmentId },
    });
    if (!row) {
      throw new NotFoundException("Unknown notification channel.");
    }
    if (!row.webhookUrl) {
      throw new BadRequestException(
        `No webhook URL configured for this ${row.type} channel — save one first.`,
      );
    }
    // Fail fast on a private/non-https target before opening a socket.
    try {
      await assertEgressAllowed(row.webhookUrl);
    } catch (e) {
      if (e instanceof BlockedEgressError) {
        throw new BadRequestException(
          `That webhook URL isn't allowed (${e.message}) — it must be a public https URL.`,
        );
      }
      throw e;
    }

    const payload = row.type === "teams" ? teamsTestCard() : slackTestPayload();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let res: { ok: boolean; status: number };
    try {
      res = (await safeFetch(row.webhookUrl, {
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
          row.type === "teams"
            ? " (for Teams, it must be a Workflows webhook)"
            : ""
        }.`,
      );
    }
    return { ok: true, status: res.status };
  }

  /**
   * Manual "Remind now" for a paused approval (REDESIGN-FUNCTIONALITY-GAPS.md Slice 1):
   * fan a `reminder`-flavored approval notification out to the env's enabled channels
   * with `onApprovalPending` on — the SAME channels + formatter the worker's scheduled
   * reminders use (@naary/notifications owns the shape, so the two can't drift).
   *
   * DESIGN CHOICE (documented in the slice): this is an API-SIDE send, not a worker
   * Signal round-trip. A Signal would need a new handler in the deterministic workflow
   * (new commands on EVERY run → patched() gating + replay risk) just to re-enter an
   * activity whose inputs the API already holds. The direct send is the simpler correct
   * path; scheduled reminders still run in the worker as durable timers.
   *
   * Best-effort per channel (mirrors the worker fan-out): one bad webhook doesn't stop
   * the rest; returns how many channels were actually POSTed.
   */
  async sendApprovalReminder(
    tenantId: string,
    environmentId: string,
    info: { workflowId: string; workflowKey?: string | null; title?: string },
  ): Promise<{ sent: number }> {
    const rows = await getPrisma().notificationChannel.findMany({
      where: {
        tenantId,
        environmentId,
        enabled: true,
        onApprovalPending: true,
      },
      orderBy: [{ type: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { type: true, webhookUrl: true },
    });
    // Same link semantics as the worker: absolute links only (a relative /approve/… is
    // useless as a Slack button); approvalPath mints the signed + expiring token.
    const base = resolveAppBaseUrl();
    const links = {
      approvalUrl:
        base && process.env.ENCRYPTION_KEY
          ? `${base}${approvalPath(info.workflowId)}`
          : undefined,
      runUrl: base
        ? `${base}/app/runs/${encodeURIComponent(info.workflowId)}`
        : undefined,
    };
    const input = {
      kind: "approval_pending" as const,
      flavor: "reminder" as const,
      workflowId: info.workflowId,
      workflowKey: info.workflowKey ?? undefined,
      title: info.title,
    };
    let sent = 0;
    for (const ch of rows) {
      if (!ch.webhookUrl) continue;
      try {
        await assertEgressAllowed(ch.webhookUrl);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
          await safeFetch(ch.webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(notificationPayload(input, ch.type, links)),
            signal: controller.signal,
          } as never);
          sent += 1;
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // Best-effort per channel — skip and continue (mirrors the worker).
      }
    }
    return { sent };
  }
}

/** Normalize a candidate into a deep-link base (origin + path, no query/fragment). Mirrors the
 *  worker's normalizeBaseUrl — kept local so the API stays decoupled from worker code. */
function normalizeBaseUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

/** The SPA's public base URL (APP_BASE_URL, else the first http(s) CORS origin) — the same
 *  resolution the worker's notification activity uses for deep links. */
function resolveAppBaseUrl(): string | undefined {
  const candidates = [
    process.env.APP_BASE_URL ?? "",
    ...(process.env.CORS_ORIGINS ?? "").split(","),
  ];
  for (const c of candidates) {
    const base = normalizeBaseUrl(c);
    if (base) return base;
  }
  return undefined;
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
