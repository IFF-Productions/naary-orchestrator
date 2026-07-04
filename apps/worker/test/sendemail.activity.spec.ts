import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlockedEgressError } from "@naary/connections";
import { __emailDeps, callSendEmail } from "../src/temporal/activities";

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
});
