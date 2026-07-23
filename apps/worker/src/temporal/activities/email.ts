// sendEmail node (SMTP via an smtp connection).
import { createLogger } from "@naary/logging";
import { ApplicationFailure } from "@temporalio/activity";
import nodemailer from "nodemailer";
import type { ResolvedSendEmail } from "@naary/dsl";
import {
  BlockedEgressError,
  MissingConnectionTokenError,
  NeedsReauthError,
  assertHostPublic,
  resolveSmtpUri,
} from "@naary/connections";
import {
  activityDuration,
  activityRuns,
  runCostUsd,
  secondsSince,
} from "../../metrics";
import { sanitizeEmailHtml } from "./sanitize-email-html";
import { type AgentMeta } from "./shared";

// Activities run in the worker PROCESS (a side-effect zone), so structured
// logging is fine here — unlike workflows.ts, which must stay deterministic.
// Logs carry execution-correlated ids (executionId/nodeId/tenantId) and token/
// cost numbers only — never prompts, completions, or keys (the logger scrubs).
const log = createLogger({ component: "worker" });

export interface SendEmailResult {
  status: "ok";
  messageId: string;
  costUsd: number;
}

/** SMTP round-trip bound. nodemailer's own connectionTimeout defaults to 2 minutes — far past
 *  this activity's 60s start-to-close AND the API's ~60s request gateway, so an unreachable/slow
 *  SMTP host makes a single-node "test" hang to the limit → a 504 instead of a clean error. We
 *  fail fast, well under both. Kept on __emailDeps so tests can shrink it. */
export const SMTP_TIMEOUT_MS = 15_000;

/** Distinct type so the catch maps a timeout to a clear, user-actionable failure (vs the generic
 *  "transient SMTP error"). Its message is secret-free (unlike raw nodemailer errors). */
class SmtpTimeoutError extends Error {}

// Injectable I/O seam for the sendEmail activity (swapped in unit tests so no real
// SMTP/DNS is touched): the SMTP-URI resolver, the transport factory, and the host
// SSRF check.
export const __emailDeps = {
  resolveSmtpUri,
  assertHostPublic,
  createTransport: (uri: string) => nodemailer.createTransport(uri),
};

/**
 * sendEmail node — send a message via an `smtp` connection. The SMTP URI (with
 * credentials) is read + used here and never returned/logged/in history. SSRF: the
 * SMTP host is resolved and required to be public BEFORE connecting (a
 * tenant-supplied host could otherwise point at an internal service). `from`
 * defaults to the URI's user when unset.
 */
export async function callSendEmail(
  cfg: ResolvedSendEmail,
  _input: unknown,
  meta: AgentMeta,
): Promise<SendEmailResult> {
  const startedAt = process.hrtime.bigint();
  try {
    const uri = await __emailDeps.resolveSmtpUri(
      meta.tenantId,
      cfg.connectionId,
    );
    const parsed = new URL(uri);
    // SSRF guard: reject a private/reserved SMTP host (checked at call time).
    await __emailDeps.assertHostPublic(parsed.hostname);
    const from =
      cfg.from ||
      (parsed.username ? decodeURIComponent(parsed.username) : undefined);
    const transport = __emailDeps.createTransport(uri);
    // Bound the SMTP round-trip so an unresponsive host fails fast (see SMTP_TIMEOUT_MS) rather
    // than hanging to the 60s start-to-close. transport.close() tears down the dangling socket.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let info: { messageId?: string };
    try {
      info = await Promise.race([
        transport.sendMail({
          from,
          to: cfg.to,
          subject: cfg.subject,
          ...(cfg.text !== undefined ? { text: cfg.text } : {}),
          // Sanitize outbound HTML at the egress sink (author markup rode through renderEmailHtml
          // unsanitized). Defense-in-depth — see sanitize-email-html.ts.
          ...(cfg.html !== undefined
            ? { html: sanitizeEmailHtml(cfg.html) }
            : {}),
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new SmtpTimeoutError("SMTP send timed out")),
            SMTP_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      transport.close?.();
    }
    log.info(
      {
        activity: "callSendEmail",
        executionId: meta.executionId,
        nodeId: meta.nodeId,
        tenantId: meta.tenantId,
        connectionId: cfg.connectionId,
        costUsd: cfg.costUsd ?? 0,
      },
      "email sent",
    );
    activityRuns.inc({ activity: "callSendEmail", outcome: "ok" });
    activityDuration.observe(
      { activity: "callSendEmail" },
      secondsSince(startedAt),
    );
    if ((cfg.costUsd ?? 0) > 0) runCostUsd.inc(cfg.costUsd ?? 0);
    return {
      status: "ok",
      messageId: info.messageId ?? "",
      costUsd: cfg.costUsd ?? 0,
    };
  } catch (e) {
    activityRuns.inc({ activity: "callSendEmail", outcome: "error" });
    activityDuration.observe(
      { activity: "callSendEmail" },
      secondsSince(startedAt),
    );
    if (e instanceof ApplicationFailure) throw e;
    // A missing SMTP URI, or a blocked host: the user must fix it — non-retryable.
    if (
      e instanceof MissingConnectionTokenError ||
      e instanceof NeedsReauthError
    ) {
      throw ApplicationFailure.nonRetryable(
        "SMTP connection has no usable URI — reconnect it",
        "CONNECTION_REAUTH",
      );
    }
    if (e instanceof BlockedEgressError) {
      throw ApplicationFailure.nonRetryable(e.message, "EGRESS_BLOCKED");
    }
    // The SMTP host didn't respond in time — a reachability/config problem the user must fix, so
    // non-retryable (and it fails the node test fast with a clear message instead of a 504).
    if (e instanceof SmtpTimeoutError) {
      throw ApplicationFailure.nonRetryable(
        "Email send timed out — the SMTP host did not respond. Check the connection's host and port.",
        "SEND_EMAIL_TIMEOUT",
        { connectionId: cfg.connectionId },
      );
    }
    // Transient SMTP failure (timeout, greylisting, auth). Drop the original message
    // ENTIRELY — nodemailer errors can embed the host/URI/credentials — so nothing
    // secret-bearing reaches history/logs.
    throw ApplicationFailure.retryable(
      "Email send failed (transient SMTP error)",
      "SEND_EMAIL_ERROR",
      { connectionId: cfg.connectionId },
    );
  }
}
