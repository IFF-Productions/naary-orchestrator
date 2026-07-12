import { describe, expect, it } from "vitest";
import { getTraceContext } from "../src/index";
import { Traced, TracedClass, traceActivities, withSpan } from "../src/spans";

/**
 * These run with Sentry DISABLED (initSentry never called → no client), so every helper
 * is a transparent passthrough. That's the invariant that matters for correctness: tracing
 * must never change behavior or values. Whether spans nest correctly in the Sentry UI needs
 * a live DSN + tracesSampleRate>0 and is verified manually.
 */

describe("withSpan (passthrough when Sentry is off)", () => {
  it("returns the sync value and calls fn exactly once", () => {
    let calls = 0;
    const r = withSpan("x", () => {
      calls++;
      return 42;
    });
    expect(r).toBe(42);
    expect(calls).toBe(1);
  });

  it("returns the promise for an async fn", async () => {
    const r = withSpan("x", async () => "ok");
    expect(r).toBeInstanceOf(Promise);
    expect(await r).toBe("ok");
  });

  it("rethrows what fn throws", () => {
    expect(() =>
      withSpan("x", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
  });
});

describe("@Traced / @TracedClass (behavior-preserving)", () => {
  it("method decorator preserves this, args, and return", () => {
    class Svc {
      base = 10;
      @Traced()
      add(a: number, b: number): number {
        return this.base + a + b;
      }
    }
    expect(new Svc().add(2, 3)).toBe(15);
  });

  it("class decorator wraps every method, leaving values unchanged", async () => {
    @TracedClass()
    class Svc {
      greeting = "hi";
      sync(n: number): number {
        return n * 2;
      }
      async asyncName(name: string): Promise<string> {
        return `${this.greeting} ${name}`;
      }
    }
    const s = new Svc();
    expect(s.sync(21)).toBe(42);
    expect(await s.asyncName("ada")).toBe("hi ada");
  });
});

describe("getTraceContext", () => {
  it("returns undefined when there is no active span (Sentry off)", () => {
    expect(getTraceContext()).toBeUndefined();
  });
});

describe("traceActivities", () => {
  it("wraps functions (still callable) and passes non-functions through, keys stable", async () => {
    const activities = {
      callAgent: async (x: number) => x + 1,
      __httpDeps: { fetch: "not-a-fn" },
    };
    const wrapped = traceActivities(activities);
    // Same keys — Temporal dispatches activities by object key.
    expect(Object.keys(wrapped).sort()).toEqual(["__httpDeps", "callAgent"]);
    // Function still works; non-function passed through by reference.
    expect(await wrapped.callAgent(41)).toBe(42);
    expect(wrapped.__httpDeps).toBe(activities.__httpDeps);
  });
});
