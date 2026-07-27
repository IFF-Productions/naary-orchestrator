// Tenant notification fan-out (Slack/Teams webhooks + SMTP email) + deep-link minting.
import { createHmac } from "node:crypto";
import {
  assertEgressAllowed,
  pinnedSmtpUri,
  resolveSmtpUri,
  safeFetch,
} from "@naary/connections";
import nodemailer from "nodemailer";
import type { ApprovalAwaitingRecord } from "@naary/contracts";
import { getDefaultEnvironmentId, getPrisma } from "@naary/db";
import { resolveTemplates } from "@naary/dsl";
import type { ApprovalNodeConfig } from "@naary/dsl";
import {
  type NotificationInput as FormatterNotificationInput,
  type NotificationKind,
  type NotificationLinks,
  notificationEmail,
  notificationPayload,
} from "@naary/notifications";
import { activityRuns } from "../../metrics";
import { appBaseUrlCandidates, encryptionKey } from "../../config";

// The formatting shape (kind/workflowId/workflowKey/title/detail) is owned by @naary/notifications
// — extend it with the worker-only `tenantId` rather than re-declaring the fields, so the two can't
// drift. `notificationPayload()` is typed against the formatter's input; the extra `tenantId` is
// structurally compatible.
export type { NotificationKind };
export interface NotificationInput extends FormatterNotificationInput {
  tenantId: string;
  /** The run's environment (Slice 6b) — only ITS channels are paged. Optional because
   *  pre-6b in-flight runs recorded no env in ctx; those resolve to the tenant default
   *  (the 5b makeSecretResolver precedent). */
  environmentId?: string;
}

/** One enabled channel the worker will deliver to (subset of the NotificationChannel row). */
export interface NotificationChannelRow {
  type: string; // "slack" | "teams" | "email" — worker formats per type; unknown → slack shape
  webhookUrl: string | null;
  /** Email channels (Slice 4): { connectionId, to[] } — the SMTP connection reference +
   *  recipients. The URI/credentials are resolved from the encrypted store at send time
   *  ONLY (never stored here, never in Temporal history/logs). */
  config?: unknown;
  onApprovalPending: boolean;
  onRunFailed: boolean;
  /** Budget alert-threshold opt-in (Slice 3). Optional so test seams/pre-migration rows
   *  that omit it read as OFF — the alert is never surprise-enabled. */
  onBudgetThreshold?: boolean;
  /** Promotion opt-in (Slice 4). Optional for the same never-surprise-enabled reason —
   *  though promotions are emitted API-side, the gate stays symmetric here. */
  onPromotion?: boolean;
}

/** Parse an email channel's config into { connectionId, to[] } — null when the channel
 *  isn't configured yet (no connection or no recipients → nothing to send). */
export function parseEmailChannelConfig(
  config: unknown,
): { connectionId: string; to: string[] } | null {
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

// Test seam: channel read + egress fetch, swappable so tests need no DB/network. Reads only the
// ENABLED channels of the RUN'S ENVIRONMENT (6b) — a disabled channel never sends, and a sandbox
// run never pages prod's channels. The default-env fallback lives HERE (inside the real deps
// impl, not sendNotification) so specs that swap readChannels stay DB-free and can assert the
// env argument they were handed.
export const __notifyDeps = {
  readChannels: async (
    tenantId: string,
    environmentId?: string,
  ): Promise<NotificationChannelRow[]> => {
    const envId = environmentId ?? (await getDefaultEnvironmentId(tenantId));
    return getPrisma().notificationChannel.findMany({
      where: { tenantId, environmentId: envId, enabled: true },
      // Deterministic order (findMany has no default order — Postgres would return physical
      // row order), so the fan-out is stable and testable. A tenant can have SEVERAL rows
      // per type (N Slack + N Teams webhooks) — each enabled row gets its own POST.
      orderBy: [{ type: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        type: true,
        webhookUrl: true,
        config: true,
        onApprovalPending: true,
        onRunFailed: true,
        onBudgetThreshold: true,
        onPromotion: true,
      },
    });
  },
  fetch: (url: string, init?: RequestInit) =>
    safeFetch(url, init as never) as unknown as Promise<Response>,
  assertEgressAllowed,
  // Email-channel seam (mirrors the sendEmail node's __emailDeps): the SMTP-URI resolver,
  // the host SSRF check + connect-pin, and the transport factory — swapped in tests so no
  // SMTP is touched.
  resolveSmtpUri,
  pinnedSmtpUri,
  createTransport: (uri: string) => nodemailer.createTransport(uri),
};

/** Coerce a resolved contextFields value for the display card (mirrors the template engine's
 *  `embed`: objects → JSON, null/undefined → ""). */
function displayValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Pause-side snapshot for a humanApproval gate carrying Slice-1 fields
 * (REDESIGN-FUNCTIONALITY-GAPS.md): resolve the gate's `contextFields` expressions against the
 * run ctx AT PAUSE TIME and the approver group ids to display names, and stamp `pausedAt` (the
 * clock read is exactly why this is an activity — Tier-1 rule 2). The workflow stores the
 * returned DATA in ctx under APPROVAL_CTX_KEY; the API reads it via stateQuery for the
 * awaiting inbox, decide-time enforcement, and the public approve prompt.
 *
 * SECRETS: expressions resolve through the same `resolveTemplates` every node uses, whose
 * `$secrets` root is deliberately NOT resolvable here — `{{ $secrets.NAME }}` tokens stay
 * LITERAL (isSecretRef in @naary/dsl leaves them untouched, and no secret resolver runs in
 * this activity), so a secret value can never enter the awaiting record / Temporal history
 * (Tier-1 rule 4).
 */
export async function prepareApproval(input: {
  tenantId: string;
  nodeId: string;
  config: Pick<
    ApprovalNodeConfig,
    | "approvers"
    | "slaHours"
    | "remindAfterHours"
    | "escalateAfterHours"
    | "escalateTo"
    | "contextFields"
  >;
  /** The run ctx snapshot (reserved `__` keys already stripped by the caller). */
  ctx: Record<string, unknown>;
}): Promise<ApprovalAwaitingRecord> {
  const cfg = input.config ?? {};
  const record: ApprovalAwaitingRecord = {
    nodeId: input.nodeId,
    pausedAt: new Date().toISOString(),
  };
  if (typeof cfg.slaHours === "number" && cfg.slaHours > 0) {
    record.slaHours = cfg.slaHours;
  }
  if (Array.isArray(cfg.remindAfterHours) && cfg.remindAfterHours.length > 0) {
    record.remindAfterHours = cfg.remindAfterHours;
  }
  if (
    typeof cfg.escalateAfterHours === "number" &&
    cfg.escalateAfterHours > 0
  ) {
    record.escalateAfterHours = cfg.escalateAfterHours;
    if (cfg.escalateTo) record.escalateTo = cfg.escalateTo;
  }
  if (cfg.contextFields && typeof cfg.contextFields === "object") {
    const resolved: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.contextFields)) {
      if (typeof v !== "string") continue;
      resolved[k] = displayValue(
        (resolveTemplates({ v }, input.ctx) as { v: unknown }).v,
      );
    }
    record.contextFields = resolved;
  }
  const emails = (cfg.approvers?.emails ?? []).filter(
    (e): e is string => typeof e === "string" && e.trim() !== "",
  );
  const groupIds = (cfg.approvers?.groupIds ?? []).filter(
    (g): g is string => typeof g === "string" && g !== "",
  );
  if (emails.length > 0 || groupIds.length > 0) {
    // Group DISPLAY names, tenant-scoped (a foreign/deleted group id yields no row — it is
    // kept with its id as the name so enforcement still sees it and the UI shows something).
    const rows =
      groupIds.length > 0
        ? await getPrisma().permissionGroup.findMany({
            where: { tenantId: input.tenantId, id: { in: groupIds } },
            select: { id: true, name: true },
          })
        : [];
    const nameById = new Map(rows.map((r) => [r.id, r.name]));
    record.approvers = {
      emails,
      groups: groupIds.map((id) => ({ id, name: nameById.get(id) ?? id })),
    };
  }
  return record;
}

/**
 * Signed approve/reject decision link for the pause notification (the notification-links gap). MUST
 * match the API's `mintApprovalToken` (apps/api/.../approval-token.ts): HMAC-SHA256(ENCRYPTION_KEY,
 * "approval:"+workflowId) — the API verifies it. `resolveAppBaseUrl()` prepends the host; it
 * returns undefined when EITHER the encryption key OR a resolvable base URL is missing (a relative
 * /approve/… link is useless as a Slack button). The recipient clicks it to Approve/Reject WITHOUT
 * opening the app.
 */
/**
 * Normalize a candidate into a deep-link base: require an http(s) URL and keep only origin + path
 * (drop any query/fragment — a base URL has none), trailing slash trimmed. So a stray
 * `https://host/x?y#z` in CORS_ORIGINS can't produce a broken `https://host/x?y#z/approve/…` link,
 * while a legitimately path-prefixed `APP_BASE_URL` (e.g. `https://host/app`) is preserved.
 */
export function normalizeBaseUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

/**
 * The SPA's public base URL, for building absolute notification deep links. Prefers the explicit
 * `APP_BASE_URL`; falls back to the first http(s) origin in `CORS_ORIGINS` — which prod MUST already
 * set for the browser to reach the API, so notifications get clickable links/buttons without a
 * separate var. Returns undefined only when neither yields a usable absolute URL (dev with just
 * localhost is still fine).
 */
function resolveAppBaseUrl(): string | undefined {
  const candidates = appBaseUrlCandidates();
  for (const c of candidates) {
    const base = normalizeBaseUrl(c);
    if (base) return base;
  }
  return undefined;
}

/** How long a newly minted approval link stays valid (Slice 1 expiry claim). Generous — a
 *  HITL pause can last days; the claim exists so a leaked link isn't a forever-credential. */
export const APPROVAL_LINK_TTL_SECONDS = 7 * 24 * 3600;

function approvalUrl(workflowId: string): string | undefined {
  const key = encryptionKey();
  const base = resolveAppBaseUrl();
  // Both are required for an absolute, clickable link. Without a base the URL would be
  // relative (`/approve/…`) — useless as a Slack url-button — so omit it (like runUrl).
  if (!key || !base) return undefined;
  // Expiring claim (Slice 1): the unix-seconds expiry is SIGNED INTO the token
  // (`approval:<id>:<exp>`) and travels as `exp=`, so it can't be tampered with. MUST match
  // the API's mintApprovalToken/verifyApprovalToken (approval-token.ts) — the API still
  // verifies legacy exp-less links with the old formula.
  const exp = Math.floor(Date.now() / 1000) + APPROVAL_LINK_TTL_SECONDS;
  const token = createHmac("sha256", key)
    .update(`approval:${workflowId}:${exp}`)
    .digest("hex");
  return `${base}/approve/${encodeURIComponent(workflowId)}?token=${token}&exp=${exp}`;
}

/** Deep link to the run detail page — the resource the recipient needs to act on. Needs a
 *  resolvable SPA base URL; without one there's no absolute URL to build, so undefined. */
function runUrl(workflowId: string): string | undefined {
  const base = resolveAppBaseUrl();
  if (!base) return undefined;
  return `${base}/app/runs/${encodeURIComponent(workflowId)}`;
}

/**
 * Resolve the absolute links for a notification. This is the ONLY place env + the signed HMAC
 * token are read; the pure `@naary/notifications` formatters take these as data, so token/URL
 * minting never leaves the worker (CLAUDE.md §4). Undefined when APP_BASE_URL (or, for approval,
 * ENCRYPTION_KEY) is missing — the formatter then omits that link/button.
 */
function notificationLinks(input: NotificationInput): NotificationLinks {
  const base = resolveAppBaseUrl();
  return {
    approvalUrl:
      input.kind === "approval_pending"
        ? approvalUrl(input.workflowId)
        : undefined,
    runUrl: runUrl(input.workflowId),
    // Budget alerts deep-link to the Usage & budgets page (the surface that fixes them).
    usageUrl:
      input.kind === "budget_threshold" && base
        ? `${base}/app/billing`
        : undefined,
  };
}

/**
 * Fire a tenant notification for an approval-pending or failed run. BEST-EFFORT: reads the
 * tenant's ENABLED notification channels and POSTs an egress-guarded payload to EACH one whose
 * URL is set and whose event toggle is on — so an alert fans out to Slack AND Teams (and later
 * email) independently. Each channel is isolated (its own egress guard, timeout, and try/catch)
 * so a bad/slow webhook on one channel never blocks the others. This activity NEVER throws (a
 * notification problem must not affect the run); the caller also wraps it defensively.
 */
export async function sendNotification(
  input: NotificationInput,
): Promise<void> {
  let channels: NotificationChannelRow[];
  try {
    channels = await __notifyDeps.readChannels(
      input.tenantId,
      input.environmentId,
    );
  } catch {
    // Couldn't read settings — nothing we can do; a notification failure must not affect the run.
    activityRuns.inc({ activity: "sendNotification", outcome: "error" });
    return;
  }

  // Links are channel-independent — resolve them once (reads env + mints the signed token here).
  const links = notificationLinks(input);

  for (const ch of channels) {
    // Per-channel event gating first (applies to every channel type).
    if (input.kind === "approval_pending" && !ch.onApprovalPending) continue;
    if (input.kind === "run_failed" && !ch.onRunFailed) continue;
    // Budget alerts are opt-in (default false — a missing/legacy field reads as OFF).
    if (input.kind === "budget_threshold" && ch.onBudgetThreshold !== true)
      continue;
    // Promotions are opt-in too (emitted API-side today; the gate stays symmetric here).
    if (input.kind === "promotion" && ch.onPromotion !== true) continue;

    // Isolate each channel: one bad URL / blocked egress / timeout / 5xx / SMTP failure must
    // not prevent the remaining channels from being notified.
    try {
      if (ch.type === "email") {
        // Email channel: resolve the SMTP connection AT SEND TIME (credentials never enter
        // this activity's inputs/outputs, Temporal history, or logs) and send via the same
        // transport the sendEmail node uses. Unconfigured → skip silently (like a null URL).
        const cfg = parseEmailChannelConfig(ch.config);
        if (!cfg) continue;
        const uri = await __notifyDeps.resolveSmtpUri(
          input.tenantId,
          cfg.connectionId,
        );
        const parsed = new URL(uri);
        // SSRF guard: reject a private/reserved SMTP host, and dial the ONE address that
        // check validated so nodemailer can't re-resolve it to something internal (#597).
        const dialUri = await __notifyDeps.pinnedSmtpUri(uri);
        const from = parsed.username
          ? decodeURIComponent(parsed.username)
          : undefined;
        const mail = notificationEmail(input, links);
        const transport = __notifyDeps.createTransport(dialUri);
        await transport.sendMail({
          from,
          to: cfg.to,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        });
      } else {
        // Webhook channel (slack/teams/unknown-legacy): skip when no URL is set.
        if (!ch.webhookUrl) continue;
        await __notifyDeps.assertEgressAllowed(ch.webhookUrl); // https + public
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        try {
          await __notifyDeps.fetch(ch.webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(notificationPayload(input, ch.type, links)),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      }
      activityRuns.inc({ activity: "sendNotification", outcome: "ok" });
    } catch {
      // Best-effort per channel: swallow and continue to the next. Never rethrow — an SMTP
      // error object can embed the host/URI, so nothing from it is logged either.
      activityRuns.inc({ activity: "sendNotification", outcome: "error" });
    }
  }
}
