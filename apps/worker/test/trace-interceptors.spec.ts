import { describe, expect, it } from "vitest";
import { interceptors } from "../src/temporal/workflow-trace-interceptors";

// Stand-in Temporal Payloads — the interceptor treats them as opaque, so any object works.
const p = (s: string) => ({ data: Buffer.from(s) }) as never;

describe("workflow trace interceptor (deterministic forward)", () => {
  it("forwards sentry-trace + baggage from start headers onto scheduled activities", async () => {
    const { inbound, outbound } = interceptors();

    // Workflow starts with trace headers (+ an unrelated one that must NOT be forwarded).
    await inbound?.[0].execute?.(
      {
        headers: {
          "sentry-trace": p("abc-123-1"),
          baggage: p("sentry-env=prod"),
          unrelated: p("nope"),
        },
        args: [],
      } as never,
      () => Promise.resolve("ok"),
    );

    let scheduled: { headers: Record<string, unknown> } | undefined;
    await outbound?.[0].scheduleActivity?.(
      { headers: { existing: p("keep") } } as never,
      (input) => {
        scheduled = input as never;
        return Promise.resolve();
      },
    );

    expect(scheduled?.headers).toHaveProperty("sentry-trace");
    expect(scheduled?.headers).toHaveProperty("baggage");
    expect(scheduled?.headers).toHaveProperty("existing"); // pre-existing header preserved
    expect(scheduled?.headers).not.toHaveProperty("unrelated"); // only trace keys forwarded
  });

  it("IN-FLIGHT SAFE: no trace headers ⇒ scheduleActivity input is passed through UNCHANGED", async () => {
    // A workflow started before this interceptor was deployed carries no sentry-trace header.
    const { inbound, outbound } = interceptors();
    await inbound?.[0].execute?.(
      { headers: { unrelated: p("u") }, args: [] } as never,
      () => Promise.resolve(),
    );

    const input = { headers: { a: p("1") } } as never;
    let scheduled: unknown;
    await outbound?.[0].scheduleActivity?.(input, (i) => {
      scheduled = i;
      return Promise.resolve();
    });

    // Same object reference ⇒ the ScheduleActivityTask command is byte-identical to history ⇒
    // open runs replay deterministically (no workflow.patched() gate needed).
    expect(scheduled).toBe(input);
  });
});
