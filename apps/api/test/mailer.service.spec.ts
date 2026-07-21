import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailerService } from "../src/mail/mailer.service";

const sendMail = vi.fn();
const createTransport = vi.fn(() => ({ sendMail }) as never);

let mailer: MailerService;
const savedEnv = { ...process.env };

beforeEach(() => {
  sendMail.mockReset().mockResolvedValue({ messageId: "m1" });
  createTransport.mockClear();
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
  mailer = new MailerService();
  mailer.createTransport = createTransport as never;
});
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("MailerService (#468)", () => {
  it("is a NO-OP when SMTP_URL is unset (never touches a transport)", async () => {
    expect(mailer.isConfigured()).toBe(false);
    const sent = await mailer.send({
      to: "a@x.com",
      subject: "Hi",
      text: "yo",
    });
    expect(sent).toBe(false);
    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("sends via the configured SMTP with the platform MAIL_FROM", async () => {
    process.env.SMTP_URL = "smtp://user:pass@mail.example:587";
    process.env.MAIL_FROM = "Naary <no-reply@naary.io>";
    const sent = await mailer.send({
      to: "a@x.com",
      subject: "Hi",
      text: "yo",
    });
    expect(sent).toBe(true);
    expect(createTransport).toHaveBeenCalledWith(
      "smtp://user:pass@mail.example:587",
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Naary <no-reply@naary.io>",
        to: "a@x.com",
        subject: "Hi",
        text: "yo",
      }),
    );
  });

  it("returns false (never throws) when the transport fails", async () => {
    process.env.SMTP_URL = "smtp://mail.example";
    sendMail.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(
      mailer.send({ to: "a@x.com", subject: "Hi", text: "yo" }),
    ).resolves.toBe(false);
  });

  it("sendInvitation builds a link-free accept-on-login message with the workspace name", async () => {
    process.env.SMTP_URL = "smtp://mail.example";
    await mailer.sendInvitation({
      to: "invitee@x.com",
      workspaceName: "Acme Prod",
      signInUrl: "https://app.naary.io/auth",
    });
    const msg = sendMail.mock.calls[0][0];
    expect(msg.to).toBe("invitee@x.com");
    expect(msg.subject).toContain("Acme Prod");
    expect(msg.text).toContain("invitee@x.com"); // sign in with THIS email
    expect(msg.text).toContain("https://app.naary.io/auth");
  });
});
