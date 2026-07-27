import { Injectable } from "@nestjs/common";
import { createLogger } from "@naary/logging";
import nodemailer from "nodemailer";
import { mailFrom, smtpUrl } from "../config";

const log = createLogger({ component: "api" });

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Platform transactional mailer (#468 — invitation emails). OPT-IN and BEST-EFFORT:
 *
 *  - Sends only when `SMTP_URL` is configured; otherwise it's a logged no-op, so a deployment
 *    without a platform SMTP simply doesn't send (invitations still work via accept-on-login).
 *  - A send failure is caught + logged (a classifier only — nodemailer errors can embed the
 *    host/credentials), NEVER thrown, so it can't break the control-plane action that triggered it.
 *
 * Distinct from the per-tenant `smtp` connection the sendEmail node / email notification channels
 * use: this is the APP's own transactional sender (from `MAIL_FROM`), not tenant BYO-SMTP.
 */
@Injectable()
export class MailerService {
  /** Test seam: the transport factory, swapped in tests so no real SMTP is touched. */
  createTransport: (uri: string) => nodemailer.Transporter = (uri) =>
    nodemailer.createTransport(uri);

  private uri(): string | undefined {
    return smtpUrl();
  }
  private from(): string {
    return mailFrom();
  }

  /** Whether a platform SMTP is configured (else send() is a no-op). */
  isConfigured(): boolean {
    return this.uri() !== undefined;
  }

  /** Send a message. Returns whether it was actually dispatched (false = unconfigured or failed). */
  async send(msg: MailMessage): Promise<boolean> {
    const uri = this.uri();
    if (!uri) {
      log.info(
        { subject: msg.subject },
        "platform mail skipped (SMTP_URL not configured)",
      );
      return false;
    }
    try {
      const transport = this.createTransport(uri);
      await transport.sendMail({
        from: this.from(),
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        ...(msg.html ? { html: msg.html } : {}),
      });
      log.info({ subject: msg.subject }, "platform mail sent");
      return true;
    } catch (e) {
      // NEVER surface SMTP errors to the caller, and never log the raw error (it can embed the
      // host/URI/credentials) — a classifier only, like the sendEmail node.
      log.warn(
        {
          subject: msg.subject,
          errorName: e instanceof Error ? e.name : "unknown",
        },
        "platform mail send failed (ignored — best-effort)",
      );
      return false;
    }
  }

  /**
   * Workspace-invitation email (#468). No accept LINK — Naary uses accept-on-login, so the invitee
   * just signs in with this same email; the message tells them that + where to go.
   */
  async sendInvitation(opts: {
    to: string;
    workspaceName?: string;
    signInUrl: string;
  }): Promise<boolean> {
    const ws = opts.workspaceName?.trim() || "a Naary workspace";
    const subject = `You've been invited to ${ws}`;
    const text = [
      `You've been invited to join ${ws} on Naary.`,
      "",
      `To accept, sign in with THIS email address (${opts.to}) at:`,
      opts.signInUrl,
      "",
      "No separate invitation link is needed — signing in with this address adds you automatically.",
      "If you weren't expecting this, you can safely ignore this email.",
    ].join("\n");
    return this.send({ to: opts.to, subject, text });
  }
}
