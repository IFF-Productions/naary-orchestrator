import { describe, expect, it } from "vitest";
import {
  nextProgressMessage,
  PROGRESS_MESSAGES,
} from "../src/lib/progress-messages";

describe("nextProgressMessage", () => {
  it("returns a message from the list", () => {
    expect(PROGRESS_MESSAGES).toContain(nextProgressMessage(null, () => 0));
  });

  it("never repeats the previous message back-to-back (rng lands on the excluded one)", () => {
    // rng()=0 would pick index 0 of the FILTERED pool; since prev is excluded, the
    // result can't equal prev regardless of where rng lands.
    for (const prev of PROGRESS_MESSAGES) {
      for (const r of [0, 0.25, 0.5, 0.99]) {
        expect(nextProgressMessage(prev, () => r)).not.toBe(prev);
      }
    }
  });

  it("walks the full list without an immediate repeat across many ticks", () => {
    let prev: string | null = null;
    let rngState = 0.123;
    const rng = () => {
      // cheap deterministic LCG-ish sequence in [0,1)
      rngState = ((rngState * 9301 + 49297) % 233280) / 233280;
      return rngState;
    };
    for (let i = 0; i < 200; i++) {
      const next = nextProgressMessage(prev, rng);
      expect(next).not.toBe(prev);
      expect(PROGRESS_MESSAGES).toContain(next);
      prev = next;
    }
  });

  it("clamps rng=1 (shouldn't happen, but never index out of range)", () => {
    expect(PROGRESS_MESSAGES).toContain(nextProgressMessage(null, () => 1));
  });
});
