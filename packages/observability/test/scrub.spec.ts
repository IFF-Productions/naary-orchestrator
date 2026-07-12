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
  it("replaces a no-group match cleanly (no stray offset number)", () => {
    // Regression: for patterns without a capture group, the replacer's 2nd arg is
    // the match offset (a number), not a label — it must NOT be prepended.
    const out = redactString("leaked sk-ant-aaaaaaaaaaaa here");
    expect(out).toBe("leaked [REDACTED] here");
    expect(out).not.toMatch(/\d\[REDACTED\]/);
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

  it("does not throw on GETTER-ONLY properties (Sentry span/transaction objects)", () => {
    // Reproduces the prod crash: Sentry transaction/span objects expose read-only accessors;
    // assigning to them threw "Cannot set property … which has only a getter".
    const span: Record<string, unknown> = {
      token: "nry_leak123456",
      ok: "keep",
    };
    Object.defineProperty(span, "spanId", {
      get: () => "abc",
      enumerable: true,
    }); // getter-only
    const txn = { type: "transaction", spans: [span] };

    expect(() => deepScrub(txn)).not.toThrow();
    // Writable sibling secret is still redacted; the read-only accessor is left intact.
    expect((txn.spans[0] as Record<string, unknown>).token).toBe("[REDACTED]");
    expect((txn.spans[0] as Record<string, unknown>).ok).toBe("keep");
    expect((txn.spans[0] as Record<string, unknown>).spanId).toBe("abc");
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

  it("scrubs a PERFORMANCE transaction event (beforeSendTransaction path)", () => {
    // Auto-instrumentation (http/prisma) writes URLs + SQL onto span attributes — this is
    // the shape that ships via beforeSendTransaction, which must be scrubbed like an error.
    const txn = {
      type: "transaction",
      transaction: "POST /executions/:id/approve",
      spans: [
        {
          description: "GET /hooks/resume/run-1?token=nry_leakedresumetoken123",
          data: {
            "http.url":
              "https://x/hooks/resume/run-1?token=nry_leakedresumetoken123",
            "db.statement": "SELECT * FROM users",
          },
        },
      ],
      contexts: { trace: { trace_id: "abc" } },
    };
    const out = scrubEvent(txn as Record<string, unknown>);
    const s = JSON.stringify(out);
    expect(s).not.toContain("nry_leakedresumetoken123");
    // Non-secret trace + SQL structure survive (only the secret substring is redacted).
    expect(
      (out.contexts as { trace: { trace_id: string } }).trace.trace_id,
    ).toBe("abc");
    expect(s).toContain("SELECT");
  });
});
