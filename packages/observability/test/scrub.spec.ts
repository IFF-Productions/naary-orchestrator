import { describe, expect, it } from "vitest";
import { deepScrub, redactString, scrubEvent } from "../src/scrub";

describe("redactString", () => {
  it("redacts provider/api key shapes", () => {
    expect(redactString("key sk-ant-abc123def456ghi")).not.toContain("abc123");
    expect(redactString("token nry_AbCdEf123456")).toContain("[REDACTED]");
    expect(redactString("pat ghp_0123456789abcdefghij")).toContain(
      "[REDACTED]",
    );
  });
  it("redacts a 64-hex blob (ENCRYPTION_KEY shape)", () => {
    const hex = "a".repeat(64);
    expect(redactString(`ENCRYPTION_KEY=${hex}`)).not.toContain(hex);
  });
  it("redacts a JWT", () => {
    expect(redactString("Bearer eyAAAAAAAA.eyBBBBBBBB.ccccccccc")).toContain(
      "[REDACTED]",
    );
  });
  it("leaves normal text untouched", () => {
    expect(redactString("workflow exec-t-demo-123 failed at node agent")).toBe(
      "workflow exec-t-demo-123 failed at node agent",
    );
  });
});

describe("deepScrub", () => {
  it("drops keys whose NAME is sensitive", () => {
    const o = deepScrub({
      tenantId: "t-1",
      token: "nry_secret",
      nested: { apiKey: "sk-xyz", ciphertext: "base64..", ok: "fine" },
    });
    expect(o.tenantId).toBe("t-1");
    expect(o.token).toBe("[REDACTED]");
    expect(o.nested.apiKey).toBe("[REDACTED]");
    expect(o.nested.ciphertext).toBe("[REDACTED]");
    expect(o.nested.ok).toBe("fine");
  });
  it("is cycle-safe", () => {
    const a: Record<string, unknown> = { name: "x" };
    a.self = a;
    expect(() => deepScrub(a)).not.toThrow();
  });
});

describe("scrubEvent", () => {
  it("drops the raw HTTP request and redacts exception messages", () => {
    const event = {
      request: { headers: { authorization: "Bearer nry_supersecret" } },
      exception: {
        values: [{ value: "Incorrect API key: sk-ant-LEAKED12345678" }],
      },
      tags: { tenantId: "t-1" },
    };
    const out = scrubEvent(event as Record<string, unknown>);
    expect(out.request).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("nry_supersecret");
    expect(JSON.stringify(out)).not.toContain("LEAKED");
    expect((out.tags as { tenantId: string }).tenantId).toBe("t-1");
  });
});
