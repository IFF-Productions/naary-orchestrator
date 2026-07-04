import { describe, expect, it } from "vitest";
import { FOREACH_CONCURRENCY, perChildCap } from "../src/temporal/foreach-cap";

// The Q-3 guarantee is a pure arithmetic property, so test it directly (child cost
// is mocked in the interpreter e2e, so the divisor never changes an observable
// result there). perChildCap splits the remaining parent cap across the concurrent
// children of ONE forEach window so their spends can't sum past the remaining cap.
describe("perChildCap (forEach cost-cap divisor, audit Q-3)", () => {
  it("splits the remaining cap evenly across the window's children (R/C)", () => {
    // 10 children sharing $1.00 remaining ⇒ $0.10 each ⇒ aggregate ≤ $1.00.
    expect(perChildCap(1.0, 10)).toBe(0.1);
    expect(perChildCap(1.0, 10) * 10).toBeCloseTo(1.0, 9);
  });

  it("bounds aggregate concurrent spend to the remaining cap (no N× overshoot)", () => {
    // The bug it fixes: N children each granted the FULL remaining could spend N×.
    for (const windowLen of [1, 2, 5, 10]) {
      const remaining = 0.42;
      expect(perChildCap(remaining, windowLen) * windowLen).toBeCloseTo(
        remaining,
        9,
      );
    }
  });

  it("shrinks as the running cost eats into the cap across chunks", () => {
    const cap = 1.0;
    // chunk 1: nothing spent yet ⇒ each child gets 1.0/10
    expect(perChildCap(cap - 0, 10)).toBeCloseTo(0.1, 9);
    // chunk 2: after $0.90 metered ⇒ remaining $0.10 ⇒ each gets 0.10/10
    expect(perChildCap(cap - 0.9, 10)).toBeCloseTo(0.01, 9);
  });

  it("floors at 0 when already over budget (a starved later chunk gets nothing)", () => {
    // Negative remaining ⇒ 0, so those children fail on budget rather than spend.
    expect(perChildCap(-0.5, 10)).toBe(0);
    expect(perChildCap(0, 10)).toBe(0);
  });

  it("never divides by zero on an empty window", () => {
    expect(perChildCap(1.0, 0)).toBe(1.0); // windowLen floored to 1
    expect(Number.isFinite(perChildCap(1.0, 0))).toBe(true);
  });

  it("uses a concurrency window below the fan-out cap so 100 items chunk", () => {
    // A-3: the window must be < MAX_FOREACH_ITEMS (100) or nothing is bounded.
    expect(FOREACH_CONCURRENCY).toBeGreaterThan(0);
    expect(FOREACH_CONCURRENCY).toBeLessThan(100);
  });
});
