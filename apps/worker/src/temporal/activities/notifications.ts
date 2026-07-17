// Tenant notification fan-out (Slack/Teams webhooks) + deep-link minting.
import { createHmac } from "node:crypto";
import { assertEgressAllowed, safeFetch } from "@naary/connections";
import { getPrisma } from "@naary/db";
import {
  type NotificationInput as FormatterNotificationInput,
  type NotificationKind,
  type NotificationLinks,
  notificationPayload,
} from "@naary/notifications";
import { activityRuns } from "../../metrics";

// The formatting shape (kind/workflowId/workflowKey/title/detail) is owned by @naary/notifications
// — extend it with the worker-only `tenantId` rather than re-declaring the fields, so the two can't
// drift. `notificationPayload()` is typed against the formatter's input; the extra `tenantId` is
// structurally compatible.
export type { NotificationKind };
export interface NotificationInput extends FormatterNotificationInput {
  tenantId: string;
}

/** One enabled channel the worker will POST to (subset of the NotificationChannel row). */
export interface NotificationChannelRow {
  type: string; // "slack" | "teams" | (future) — worker formats per type; unknown → slack shape
  webhookUrl: string | null;
  onApprovalPending: boolean;
  onRunFailed: boolean;
}

// Test seam: channel read + egress fetch, swappable so tests need no DB/network. Reads only the
// ENABLED channels — a disabled channel never sends, regardless of its saved URL/flags.
export const __notifyDeps = {
  readChannels: (tenantId: string): Promise<NotificationChannelRow[]> =>
    getPrisma().notificationChannel.findMany({
      where: { tenantId, enabled: true },
      // Deterministic order (findMany has no default order — Postgres would return physical
      // row order), so the fan-out is stable and testable. A tenant can have SEVERAL rows
      // per type (N Slack + N Teams webhooks) — each enabled row gets its own POST.
      orderBy: [{ type: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        type: true,
        webhookUrl: true,
        onApprovalPending: true,
        onRunFailed: true,
      },
    }),
  fetch: (url: string, init?: RequestInit) =>
    safeFetch(url, init as never) as unknown as Promise<Response>,
  assertEgressAllowed,
};

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

function approvalUrl(workflowId: string): string | undefined {
  const key = process.env.ENCRYPTION_KEY;
  const base = resolveAppBaseUrl();
  // Both are required for an absolute, clickable link. Without a base the URL would be
  // relative (`/approve/…`) — useless as a Slack url-button — so omit it (like runUrl).
  if (!key || !base) return undefined;
  const token = createHmac("sha256", key)
    .update(`approval:${workflowId}`)
    .digest("hex");
  return `${base}/approve/${encodeURIComponent(workflowId)}?token=${token}`;
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
  return {
    approvalUrl:
      input.kind === "approval_pending"
        ? approvalUrl(input.workflowId)
        : undefined,
    runUrl: runUrl(input.workflowId),
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
    channels = await __notifyDeps.readChannels(input.tenantId);
  } catch {
    // Couldn't read settings — nothing we can do; a notification failure must not affect the run.
    activityRuns.inc({ activity: "sendNotification", outcome: "error" });
    return;
  }

  // Links are channel-independent — resolve them once (reads env + mints the signed token here).
  const links = notificationLinks(input);

  for (const ch of channels) {
    // Per-channel gating: skip channels with no URL or with this event toggled off.
    if (!ch.webhookUrl) continue;
    if (input.kind === "approval_pending" && !ch.onApprovalPending) continue;
    if (input.kind === "run_failed" && !ch.onRunFailed) continue;

    // Isolate each channel: one bad URL / blocked egress / timeout / 5xx must not prevent the
    // remaining channels from being notified.
    try {
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
      activityRuns.inc({ activity: "sendNotification", outcome: "ok" });
    } catch {
      // Best-effort per channel: swallow and continue to the next.
      activityRuns.inc({ activity: "sendNotification", outcome: "error" });
    }
  }
}
