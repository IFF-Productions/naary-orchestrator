import { describe, expect, it } from "vitest";
import {
  continueSentryTrace,
  getSentryTraceHeaders,
} from "../src/temporal-trace";

// No initSentry() here ⇒ no Sentry client ⇒ the propagation helpers must degrade to no-ops
// (this is the fail-safe path the whole design relies on: tracing off ⇒ nothing breaks).
describe("temporal-trace helpers (fail-safe when tracing is off)", () => {
  it("getSentryTraceHeaders returns {} with no Sentry client", () => {
    expect(getSentryTraceHeaders()).toEqual({});
  });

  it("continueSentryTrace just runs the callback when there's no client or no incoming trace", () => {
    expect(continueSentryTrace("trace", "baggage", () => 42)).toBe(42);
    expect(continueSentryTrace(undefined, undefined, () => 7)).toBe(7);
  });
});
