import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  assertEgressAllowed,
  BlockedEgressError,
  pinnedSmtpUri,
  resolveSmtpUri,
  safeFetch,
} from "@naary/connections";
import { getPrisma } from "@naary/db";
import {
  type NotificationInput,
  type NotificationLinks,
  notificationEmail,
  notificationPayload,
} from "@naary/notifications";
import nodemailer from "nodemailer";
import { approvalPath } from "../executions/approval-token";

/** Channel types the product ships today. A tenant may have ANY NUMBER of channels per
 *  type (N Slack webhooks + N email lists, each its own row). */
export const NOTIFICATION_CHANNEL_TYPES = ["slack", "teams", "email"] as const;
export type NotificationChannelType =
  (typeof NOTIFICATION_CHANNEL_TYPES)[number];

/** Per-environment channel cap — plenty for real fan-out, a backstop against abuse (each
 *  enabled row is an outbound POST/email per event). */
export const MAX_CHANNELS_PER_ENV = 20;

/** Recipient cap per email channel — a notification list, not a mailing list. */
export const MAX_EMAIL_RECIPIENTS = 10;

function isChannelType(v: string): v is NotificationChannelType {
  return (NOTIFICATION_CHANNEL_TYPES as readonly string[]).includes(v);
}

/**
 * API-side email seam (mirrors the worker's `__notifyDeps`): the SMTP-URI resolver, the
 * host SSRF check + connect-pin, and the transport factory — swapped in unit tests so no SMTP/DNS is
 * touched. The URI (with credentials) is resolved AT SEND TIME from the encrypted store
 * via the same machinery the sendEmail node uses, used in memory, never returned/logged.
 */
export const __apiNotifyDeps = {
  resolveSmtpUri,
  pinnedSmtpUri,
  createTransport: (uri: string) => nodemailer.createTransport(uri),
};

/** Email channel config as stored in the row's `config` Json: the SMTP connection
 *  reference + recipients. Null = not configured yet (sends skip the channel). */
interface EmailChannelConfig {
  connectionId: string;
  to: string[];
}

/** Parse a row's `config` Json into the email shape — null when unusable/unconfigured. */
function parseEmailConfig(config: unknown): EmailChannelConfig | null {
  if (!config || typeof config !== "object") return null;
  const c = config as { connectionId?: unknown; to?: unknown };
  const connectionId =
    typeof c.connectionId === "string" && c.connectionId
      ? c.connectionId
      : null;
  const to = Array.isArray(c.to)
    ? c.to.filter((t): t is string => typeof t === "string" && t.trim() !== "")
    : [];
  if (!connectionId || to.length === 0) return null;
  return { connectionId, to };
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
  /** Email channels only: the SMTP connection this channel sends through (same
   *  connection type the sendEmail node uses). Null for webhook channels / unconfigured. */
  emailConnectionId: string | null;
  /** Email channels only: recipient addresses. Empty for webhook channels. */
  emailTo: string[];
  onApprovalPending: boolean;
  onRunFailed: boolean;
  /** Budget alert-threshold opt-in (Slice 3). Default false — never surprise-enabled. */
  onBudgetThreshold: boolean;
  /** Promotion opt-in (Slice 4). Default false — never surprise-enabled. */
  onPromotion: boolean;
}

export interface ChannelPatch {
  label?: string | null;
  enabled?: boolean;
  webhookUrl?: string | null;
  /** Email channels: set/replace the SMTP connection (null clears it). */
  emailConnectionId?: string | null;
  /** Email channels: replace the recipient list. */
  emailTo?: string[];
  onApprovalPending?: boolean;
  onRunFailed?: boolean;
  onBudgetThreshold?: boolean;
  onPromotion?: boolean;
}

interface ChannelRow {
  id: string;
  type: string;
  label: string | null;
  enabled: boolean;
  webhookUrl: string | null;
  config: unknown;
  onApprovalPending: boolean;
  onRunFailed: boolean;
  onBudgetThreshold: boolean;
  onPromotion: boolean;
}

function toView(row: ChannelRow): NotificationChannelView {
  // Email config surfaces as flat fields (connection reference + recipients — NEVER
  // credentials; the SMTP URI lives in the encrypted store keyed by the connection).
  const cfg =
    row.type === "email" && row.config && typeof row.config === "object"
      ? (row.config as { connectionId?: unknown; to?: unknown })
      : null;
  return {
    id: row.id,
    type: row.type as NotificationChannelType,
    label: row.label,
    enabled: row.enabled,
    webhookUrl: row.webhookUrl,
    emailConnectionId:
      cfg && typeof cfg.connectionId === "string" ? cfg.connectionId : null,
    emailTo:
      cfg && Array.isArray(cfg.to)
        ? cfg.to.filter((t): t is string => typeof t === "string")
        : [],
    onApprovalPending: row.onApprovalPending,
    onRunFailed: row.onRunFailed,
    onBudgetThreshold: row.onBudgetThreshold,
    onPromotion: row.onPromotion,
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

  /**
   * Validate an email channel's config patch (Slice 4): the referenced connection must
   * exist, be an `smtp` connection, and belong to the SAME tenant + environment as the
   * channel (an email channel must not send through another env's credentials). Recipients
   * are capped and shape-checked. Only the fields PRESENT in the patch are validated.
   */
  private async validateEmailPatch(
    tenantId: string,
    environmentId: string,
    patch: ChannelPatch,
  ): Promise<void> {
    if (patch.emailConnectionId != null) {
      const conn = await getPrisma().connection.findFirst({
        where: { id: patch.emailConnectionId, tenantId, environmentId },
        select: { type: true },
      });
      if (!conn) {
        throw new BadRequestException(
          "Unknown SMTP connection in this environment — pick one from Integrations.",
        );
      }
      if (conn.type !== "smtp") {
        throw new BadRequestException(
          "That connection isn't an SMTP connection — email channels send through an smtp connection.",
        );
      }
    }
    if (patch.emailTo !== undefined) {
      const to = patch.emailTo.map((t) => t.trim()).filter((t) => t !== "");
      if (to.length > MAX_EMAIL_RECIPIENTS) {
        throw new BadRequestException(
          `Too many recipients (max ${MAX_EMAIL_RECIPIENTS}).`,
        );
      }
      for (const addr of to) {
        // Deliberately loose (the SMTP server is the authority) — just enough to catch
        // a pasted name or URL: one @, no spaces, something on both sides.
        if (addr.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
          throw new BadRequestException(
            `'${addr}' doesn't look like an email address.`,
          );
        }
      }
    }
  }

  /** The next `config` Json for an email channel: existing config merged with the patch's
   *  email fields (undefined = leave unchanged; null connection clears it). */
  private nextEmailConfig(
    existing: unknown,
    patch: ChannelPatch,
  ): { connectionId?: string; to?: string[] } | null {
    const prev =
      existing && typeof existing === "object"
        ? (existing as { connectionId?: unknown; to?: unknown })
        : {};
    const connectionId =
      patch.emailConnectionId !== undefined
        ? (patch.emailConnectionId ?? undefined)
        : typeof prev.connectionId === "string"
          ? prev.connectionId
          : undefined;
    const to =
      patch.emailTo !== undefined
        ? patch.emailTo.map((t) => t.trim()).filter((t) => t !== "")
        : Array.isArray(prev.to)
          ? prev.to.filter((t): t is string => typeof t === "string")
          : undefined;
    if (connectionId === undefined && (to === undefined || to.length === 0)) {
      return null;
    }
    return {
      ...(connectionId !== undefined ? { connectionId } : {}),
      ...(to !== undefined ? { to } : {}),
    };
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
    if (type === "email") {
      await this.validateEmailPatch(tenantId, environmentId, patch);
    }
    const config =
      type === "email" ? this.nextEmailConfig(null, patch) : undefined;
    const row = await getPrisma().notificationChannel.create({
      data: {
        tenantId,
        environmentId,
        type,
        label: normalize(patch.label) ?? null,
        enabled: patch.enabled ?? true,
        webhookUrl: normalize(patch.webhookUrl) ?? null,
        ...(config !== undefined ? { config: config ?? undefined } : {}),
        onApprovalPending: patch.onApprovalPending ?? true,
        onRunFailed: patch.onRunFailed ?? true,
        // Budget alerts are opt-in (Slice 3): default OFF even on a fresh channel.
        onBudgetThreshold: patch.onBudgetThreshold ?? false,
        // Promotions are opt-in (Slice 4): default OFF even on a fresh channel.
        onPromotion: patch.onPromotion ?? false,
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
      select: { id: true, type: true, config: true },
    });
    if (!existing) {
      throw new NotFoundException("Unknown notification channel.");
    }
    const touchesEmail =
      existing.type === "email" &&
      (patch.emailConnectionId !== undefined || patch.emailTo !== undefined);
    if (touchesEmail) {
      await this.validateEmailPatch(tenantId, environmentId, patch);
    }
    const row = await getPrisma().notificationChannel.update({
      where: { id: channelId },
      data: {
        label: normalize(patch.label),
        enabled: patch.enabled,
        webhookUrl: normalize(patch.webhookUrl),
        ...(touchesEmail
          ? {
              config: this.nextEmailConfig(existing.config, patch) ?? undefined,
            }
          : {}),
        onApprovalPending: patch.onApprovalPending,
        onRunFailed: patch.onRunFailed,
        onBudgetThreshold: patch.onBudgetThreshold,
        onPromotion: patch.onPromotion,
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
    if (row.type === "email") {
      return this.sendTestEmail(tenantId, row.config);
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
      select: { type: true, webhookUrl: true, config: true },
    });
    // Same link semantics as the worker: absolute links only (a relative /approve/… is
    // useless as a Slack button); approvalPath mints the signed + expiring token.
    const base = resolveAppBaseUrl();
    const links: NotificationLinks = {
      approvalUrl:
        base && process.env.ENCRYPTION_KEY
          ? `${base}${approvalPath(info.workflowId)}`
          : undefined,
      runUrl: base
        ? `${base}/app/runs/${encodeURIComponent(info.workflowId)}`
        : undefined,
    };
    const input: NotificationInput = {
      kind: "approval_pending",
      flavor: "reminder",
      workflowId: info.workflowId,
      workflowKey: info.workflowKey ?? undefined,
      title: info.title,
    };
    return this.fanOut(tenantId, rows, input, links);
  }

  /**
   * Promotion notification (Slice 4): a workflow was promoted INTO an environment —
   * announced to the TARGET env's channels with `onPromotion` on (the env receiving the
   * new version is the one whose watchers care; env-scoped routing as everywhere else).
   * API-side send like reminders (the promote path lives here — no worker round-trip);
   * best-effort per channel and NEVER throws: a notification problem must not fail the
   * promote that already happened.
   */
  async sendPromotion(
    tenantId: string,
    targetEnvironmentId: string,
    info: {
      workflowKey: string;
      fromEnv: string;
      toEnv: string;
      version: number;
    },
  ): Promise<{ sent: number }> {
    try {
      const rows = await getPrisma().notificationChannel.findMany({
        where: {
          tenantId,
          environmentId: targetEnvironmentId,
          enabled: true,
          onPromotion: true,
        },
        orderBy: [{ type: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: { type: true, webhookUrl: true, config: true },
      });
      const base = resolveAppBaseUrl();
      const links: NotificationLinks = {
        workflowUrl: base
          ? `${base}/app/workflows/${encodeURIComponent(info.workflowKey)}`
          : undefined,
      };
      const input: NotificationInput = {
        kind: "promotion",
        // Promotions have no run — workflowId carries the key (the formatter's contract).
        workflowId: info.workflowKey,
        workflowKey: info.workflowKey,
        fromEnv: info.fromEnv,
        toEnv: info.toEnv,
        version: info.version,
      };
      return await this.fanOut(tenantId, rows, input, links);
    } catch {
      // Even the channel READ is best-effort here — the promote itself already succeeded.
      return { sent: 0 };
    }
  }

  /** Best-effort fan-out of ONE formatted notification to a set of channel rows —
   *  webhook POST or SMTP email per row, each isolated (one failure never stops the
   *  rest; mirrors the worker's posture). Returns how many channels actually sent. */
  private async fanOut(
    tenantId: string,
    rows: { type: string; webhookUrl: string | null; config: unknown }[],
    input: NotificationInput,
    links: NotificationLinks,
  ): Promise<{ sent: number }> {
    let sent = 0;
    for (const ch of rows) {
      try {
        if (ch.type === "email") {
          const cfg = parseEmailConfig(ch.config);
          if (!cfg) continue; // unconfigured — nothing to send
          await this.sendEmail(tenantId, cfg, notificationEmail(input, links));
          sent += 1;
          continue;
        }
        if (!ch.webhookUrl) continue;
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
        // Best-effort per channel — skip and continue (mirrors the worker). Nothing from
        // the error is logged either: an SMTP error can embed the credentialed URI.
      }
    }
    return { sent };
  }

  /**
   * Resolve the channel's SMTP connection and send one email. The credentialed URI is
   * read from the encrypted store via the SAME machinery the sendEmail node uses
   * (`resolveSmtpUri`), held in memory for the send, and never returned/logged. SSRF:
   * the SMTP host must resolve public before connecting.
   */
  private async sendEmail(
    tenantId: string,
    cfg: EmailChannelConfig,
    mail: { subject: string; text: string; html: string },
  ): Promise<void> {
    const uri = await __apiNotifyDeps.resolveSmtpUri(
      tenantId,
      cfg.connectionId,
    );
    const parsed = new URL(uri);
    // SSRF guard: reject a private/reserved SMTP host, and dial the ONE address that check
    // validated so nodemailer can't re-resolve it to something internal (#597).
    const dialUri = await __apiNotifyDeps.pinnedSmtpUri(uri);
    const from = parsed.username
      ? decodeURIComponent(parsed.username)
      : undefined;
    const transport = __apiNotifyDeps.createTransport(dialUri);
    await transport.sendMail({
      from,
      to: cfg.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
  }

  /** Send-test for an email channel: a real end-to-end SMTP send to the saved recipients.
   *  Failures surface as 400s with a GENERIC message — an SMTP error can embed the
   *  credentialed URI, so its text never reaches the client. */
  private async sendTestEmail(
    tenantId: string,
    config: unknown,
  ): Promise<{ ok: true; status: number }> {
    const cfg = parseEmailConfig(config);
    if (!cfg) {
      throw new BadRequestException(
        "No SMTP connection or recipients configured for this email channel — save them first.",
      );
    }
    try {
      await this.sendEmail(tenantId, cfg, emailTestMessage());
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(
        "Couldn't send the test email — check the SMTP connection and recipients.",
      );
    }
    return { ok: true, status: 200 };
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

/** Minimal test email — subject + both bodies. Enough to confirm SMTP delivery + rendering. */
function emailTestMessage(): { subject: string; text: string; html: string } {
  return {
    subject: "🔔 Test notification from Naary",
    text: "Your Naary email channel is configured correctly. Real alerts (approvals, run failures, budget, promotions) will arrive here.",
    html: `<div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1f2328;max-width:560px;"><h2 style="font-size:17px;margin:0 0 12px;">🔔 Test notification</h2><p style="margin:0;">Your Naary email channel is configured correctly. Real alerts (approvals, run failures, budget, promotions) will arrive here.</p></div>`,
  };
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
