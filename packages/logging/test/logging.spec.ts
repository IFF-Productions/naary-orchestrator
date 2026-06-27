import { describe, expect, it } from "vitest";
import { createLogger, newCorrelationId } from "../src/index";

/** Collect pino's JSON lines into memory so we can assert on them. */
function capture(): {
  lines: Record<string, unknown>[];
  stream: { write(s: string): void };
} {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    stream: {
      write(s: string) {
        lines.push(JSON.parse(s));
      },
    },
  };
}

describe("createLogger", () => {
  it("emits structured JSON with the component base field and word-level", () => {
    const { lines, stream } = capture();
    const log = createLogger({ component: "api" }, stream);
    log.info({ requestId: "r1" }, "hello");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      component: "api",
      level: "info",
      requestId: "r1",
      msg: "hello",
    });
    expect(typeof lines[0].time).toBe("string"); // ISO timestamp, not epoch ms
  });

  it("drops sensitive-named fields by key", () => {
    const { lines, stream } = capture();
    const log = createLogger({ component: "worker" }, stream);
    log.info(
      { apiKey: "sk-ant-abcdefghijklmnop", tenantId: "t-demo" },
      "node done",
    );

    expect(lines[0].apiKey).toBe("[REDACTED]");
    expect(lines[0].tenantId).toBe("t-demo"); // safe identifier — preserved
  });

  it("redacts secret-shaped substrings inside the message", () => {
    const { lines, stream } = capture();
    const log = createLogger({ component: "api" }, stream);
    log.error("provider rejected token nry_abcdefghijklmnop12345");

    expect(lines[0].msg).not.toContain("nry_abcdefghijklmnop");
    expect(lines[0].msg).toContain("[REDACTED]");
  });

  it("scrubs nested fields and child-logger bindings", () => {
    const { lines, stream } = capture();
    const root = createLogger({ component: "worker" }, stream);
    const child = root.child({ executionId: "e1" });
    child.info({ detail: { password: "hunter2" } }, "x");

    expect(lines[0].executionId).toBe("e1");
    expect((lines[0].detail as Record<string, unknown>).password).toBe(
      "[REDACTED]",
    );
  });
});

describe("newCorrelationId", () => {
  it("returns a uuid-shaped string", () => {
    expect(newCorrelationId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
