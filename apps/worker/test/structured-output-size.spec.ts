import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertStructuredOutputSize,
  MAX_STRUCTURED_OUTPUT_BYTES,
} from "../src/temporal/activities/structured-output-size";

/**
 * #827 — a node's structured output rides in Temporal history, and the SCHEMA is user-authored, so
 * it can outgrow the ~2MB payload cap. This guard doesn't forbid anything new; it turns a payload
 * rejection ("opaque, and at the worst moment") into a message naming the node and the size.
 */

const bigString = (bytes: number) => "x".repeat(bytes);

describe("assertStructuredOutputSize", () => {
  it("passes a normal structured output", () => {
    expect(() =>
      assertStructuredOutputSize(
        { title: "A bug", severity: "high" },
        "triage",
      ),
    ).not.toThrow();
  });

  it("passes when there is no structured output at all", () => {
    expect(() => assertStructuredOutputSize(undefined, "n")).not.toThrow();
    expect(() => assertStructuredOutputSize(null, "n")).not.toThrow();
  });

  it("names the node, the size and what to do", () => {
    let msg = "";
    try {
      assertStructuredOutputSize(
        { blob: bigString(MAX_STRUCTURED_OUTPUT_BYTES + 1024) },
        "summarize",
      );
    } catch (e) {
      msg = (e as Error).message;
    }

    expect(msg).toContain('"summarize"'); // WHICH node
    expect(msg).toMatch(/1\.0 MB of structured output/); // how big
    expect(msg).toMatch(/narrow the node's output schema/); // what to do
  });

  /**
   * Non-retryable on purpose: the cause is the authored schema, so a retry re-pays for the same
   * model call and produces the same oversized result — the same reasoning that makes 401/429
   * non-retryable in the agent activity.
   */
  it("is non-retryable and carries a machine-readable type", () => {
    try {
      assertStructuredOutputSize({ b: bigString(2_000_000) }, "n");
      expect.unreachable("should have thrown");
    } catch (e) {
      const f = e as { nonRetryable?: boolean; type?: string };
      expect(f.nonRetryable).toBe(true);
      expect(f.type).toBe("STRUCTURED_OUTPUT_TOO_LARGE");
    }
  });

  it("allows a payload right at the limit, and rejects just past it", () => {
    // MEASURE the JSON envelope rather than guessing it — my first attempt assumed 10 bytes for
    // `{"b":"…"}` when it is 8, which put "over the limit" exactly ON the limit and the test
    // failed for the wrong reason.
    const envelope = JSON.stringify({ b: "" }).length;
    const atLimit = { b: bigString(MAX_STRUCTURED_OUTPUT_BYTES - envelope) };
    const overLimit = {
      b: bigString(MAX_STRUCTURED_OUTPUT_BYTES - envelope + 1),
    };

    // The boundary is only meaningful if these really straddle it.
    expect(JSON.stringify(atLimit).length).toBe(MAX_STRUCTURED_OUTPUT_BYTES);
    expect(JSON.stringify(overLimit).length).toBe(
      MAX_STRUCTURED_OUTPUT_BYTES + 1,
    );

    expect(() => assertStructuredOutputSize(atLimit, "n")).not.toThrow();
    expect(() => assertStructuredOutputSize(overLimit, "n")).toThrow();
  });

  it("stays out of the way of an unserialisable value", () => {
    // A cycle can't be measured; the payload converter reports it far better than a guess here.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => assertStructuredOutputSize(cyclic, "n")).not.toThrow();
  });
});

/**
 * THE ORDERING IS THE POINT, and it is the part most likely to rot: the model has already run and
 * been billed when this fires, so throwing before `recordUsage` would lose the spend — the exact
 * failure "billing must fail safe" exists to prevent (CLAUDE.md Tier-1 rule 6).
 *
 * Asserted against the SOURCE because there is no seam to observe it through: both call sites are
 * deep inside long activities whose deps are module-level. A source check is blunt, but it fails
 * if someone moves the guard above the ledger write — which a comment alone would not.
 */
describe("the guard runs AFTER the usage is recorded", () => {
  const activityDir = join(__dirname, "../src/temporal/activities");

  // How many `recordUsage({` call sites each file is KNOWN to have. `agent.ts` has two: the
  // guardrail-blocked branch bills and then fails non-retryably, and the main path bills every
  // call. Pinned because the ordering check below is only as good as its knowledge of them —
  // see the comment in the test.
  it.each([
    ["agent.ts", 2],
    ["code-agent.ts", 1],
  ])("%s bills before it can reject", (file, ledgerSites) => {
    const src = readFileSync(join(activityDir, file), "utf8");
    // `lastIndexOf`, NOT `indexOf`. This used to take the FIRST `recordUsage({` in the file, which
    // in agent.ts is the rarely-taken guardrail-blocked branch at the top — not the ledger write
    // that bills every call. Measured: move the main ledger write BELOW the guard, which is the
    // one regression this whole file exists to catch and which loses the spend on every rejected
    // oversized output, and the old assertion stayed GREEN because the guardrail branch still sat
    // above it. The invariant is that the guard follows EVERY ledger write, so compare with the
    // last one.
    const ledger = src.lastIndexOf("recordUsage({");
    const guard = src.indexOf("assertStructuredOutputSize(");

    expect(ledger, `${file}: no recordUsage call found`).toBeGreaterThan(-1);
    expect(
      src.split("recordUsage({").length - 1,
      `${file}: the number of recordUsage call sites changed — re-read the ordering rule below ` +
        `and update this count deliberately`,
    ).toBe(ledgerSites);
    expect(
      guard,
      `${file}: the size guard is missing entirely`,
    ).toBeGreaterThan(-1);
    expect(
      guard,
      `${file}: the guard must come AFTER every recordUsage, or a rejected oversized output loses the spend`,
    ).toBeGreaterThan(ledger);
  });
});
