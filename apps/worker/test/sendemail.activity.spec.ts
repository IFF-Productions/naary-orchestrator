import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlockedEgressError } from "@naary/connections";
import { __emailDeps, callSendEmail } from "../src/temporal/activities";
import { SMTP_TIMEOUT_MS } from "../src/temporal/activities/email";

const URI = "smtps://mailer:s3cret@smtp.example.com:465";
const meta = { tenantId: "t-1", executionId: "e-1", nodeId: "n-1" };

const resolveSmtpUri = vi.fn();
const assertHostPublic = vi.fn();
const sendMail = vi.fn();
const createTransport = vi.fn(() => ({ sendMail }));

beforeEach(() => {
  resolveSmtpUri.mockReset().mockResolvedValue(URI);
  assertHostPublic.mockReset().mockResolvedValue(undefined);
  sendMail.mockReset().mockResolvedValue({ messageId: "<abc@smtp>" });
  createTransport.mockClear();
  __emailDeps.resolveSmtpUri = resolveSmtpUri as never;
  __emailDeps.assertHostPublic = assertHostPublic as never;
  __emailDeps.createTransport = createTransport as never;
});

describe("callSendEmail", () => {
  it("builds the message, checks the host, and sends via the connection's transport", async () => {
    const r = await callSendEmail(
      {
        connectionId: "smtp-1",
        from: "",
        to: "user@corp.co",
        subject: "hi",
        text: "hello",
      },
      undefined,
      meta,
    );
    expect(r).toEqual({ status: "ok", messageId: "<abc@smtp>", costUsd: 0 });
    // SSRF: the SMTP host was checked before connecting
    expect(assertHostPublic).toHaveBeenCalledWith("smtp.example.com");
    // transport built from the resolved URI; message shaped correctly, `from`
    // fell back to the URI's user
    expect(createTransport).toHaveBeenCalledWith(URI);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "mailer",
        to: "user@corp.co",
        subject: "hi",
        text: "hello",
      }),
    );
  });

  it("sanitizes outbound HTML at the egress sink (strips script/handlers, keeps safe markup + styles)", async () => {
    await callSendEmail(
      {
        connectionId: "smtp-1",
        from: "",
        to: "user@corp.co",
        subject: "hi",
        html:
          "<h2>Hi</h2><div><strong>Bold</strong> " +
          '<a href="https://x.com">link</a>' +
          '<img src="https://x.com/a.png" alt="a" style="max-width:100%" />' +
          '<div style="height:24px"></div>' +
          "<script>alert(1)</script>" +
          '<img src="x" onerror="alert(2)">' +
          '<a href="javascript:alert(3)">bad</a></div>',
      },
      undefined,
      meta,
    );
    const sent = sendMail.mock.calls[0][0].html as string;
    // Dangerous vectors gone
    expect(sent).not.toMatch(/<script/i);
    expect(sent).not.toMatch(/onerror/i);
    expect(sent).not.toMatch(/javascript:/i);
    // Safe markup + the two inline styles renderEmailHtml emits survive
    expect(sent).toMatch(/<h2>Hi<\/h2>/);
    expect(sent).toMatch(/<strong>Bold<\/strong>/);
    expect(sent).toMatch(/<a href="https:\/\/x\.com">link<\/a>/);
    expect(sent).toMatch(/max-width:\s*100%/);
    expect(sent).toMatch(/height:\s*24px/);
  });

  it("rejects a private/reserved SMTP host (SSRF guard) — non-retryable, no creds leak", async () => {
    assertHostPublic.mockRejectedValue(
      new BlockedEgressError("host resolves to a private/reserved address"),
    );
    const err = await callSendEmail(
      { connectionId: "smtp-1", from: "", to: "a@b.co", subject: "x" },
      undefined,
      meta,
    ).catch((e) => e);
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("EGRESS_BLOCKED");
    expect(sendMail).not.toHaveBeenCalled(); // never connected
    expect(JSON.stringify(err)).not.toContain("s3cret");
  });

  it("a transient send failure is sanitized (SMTP URI/creds never leak)", async () => {
    sendMail.mockRejectedValue(new Error(`connect ECONNREFUSED via ${URI}`));
    const err = await callSendEmail(
      { connectionId: "smtp-1", from: "", to: "a@b.co", subject: "x" },
      undefined,
      meta,
    ).catch((e) => e);
    expect(JSON.stringify(err)).not.toContain("s3cret");
  });

  it("a hung SMTP host times out fast (SEND_EMAIL_TIMEOUT), tears down the socket, no 60s hang", async () => {
    vi.useFakeTimers();
    // Connection never settles — the real-world cause of the /nodes/email/test 504.
    sendMail.mockReturnValue(new Promise<never>(() => {}));
    const close = vi.fn();
    createTransport.mockReturnValue({ sendMail, close } as never);

    const p = callSendEmail(
      { connectionId: "smtp-1", from: "", to: "a@b.co", subject: "x" },
      undefined,
      meta,
    ).catch((e) => e);
    // Advance PAST the SMTP bound; the activity must reject rather than run to 60s.
    await vi.advanceTimersByTimeAsync(SMTP_TIMEOUT_MS + 50);
    const err = await p;
    vi.useRealTimers();

    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("SEND_EMAIL_TIMEOUT");
    expect(close).toHaveBeenCalled(); // dangling socket torn down
    expect(JSON.stringify(err)).not.toContain("s3cret");
  });
});
