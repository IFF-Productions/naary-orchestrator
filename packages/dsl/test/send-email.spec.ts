import { describe, expect, it } from "vitest";
import { resolveSendEmail } from "../src/send-email";
import type { SendEmailNodeConfig } from "../src/types";

const ctx = {
  trigger: { email: "user@corp.co", name: "Ada" },
  agent: { output: { summary: "all good" } },
};

describe("resolveSendEmail", () => {
  it("passes static fields through and defaults from/to/subject to empty", () => {
    const config: SendEmailNodeConfig = {
      connectionId: "smtp-1",
      to: "a@b.co",
      subject: "hi",
      text: "hello",
    };
    expect(resolveSendEmail(config, ctx)).toEqual({
      connectionId: "smtp-1",
      from: "",
      to: "a@b.co",
      subject: "hi",
      text: "hello",
      costUsd: undefined,
    });
  });

  it("bindings override to/subject/text from upstream outputs", () => {
    const config: SendEmailNodeConfig = {
      connectionId: "smtp-1",
      to: "STATIC",
      subject: "STATIC",
      fieldBindings: {
        to: { from: "trigger", path: "email" },
        text: { from: "agent", path: "output.summary" },
      },
    };
    const r = resolveSendEmail(config, ctx);
    expect(r.to).toBe("user@corp.co");
    expect(r.text).toBe("all good");
    expect(r.subject).toBe("STATIC");
  });

  it("never carries an SMTP URI (only connectionId)", () => {
    const r = resolveSendEmail({ connectionId: "smtp-1", to: "a@b.co" }, ctx);
    expect(Object.keys(r)).not.toContain("uri");
    expect(Object.keys(r)).not.toContain("password");
  });
});
