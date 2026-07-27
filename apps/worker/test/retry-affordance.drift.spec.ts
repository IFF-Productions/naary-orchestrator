import { describe, expect, it } from "vitest";
import { RETRYABLE_NODE_KINDS } from "@naary/dsl";
import { NODE_HANDLERS } from "../src/temporal/workflow/node-handlers";

/**
 * Drift guard for per-node `retry` (`NodeDef.retry`).
 *
 * The same truth lived in THREE places and they had already come apart: the DSL doc comment listed
 * 5 kinds, the worker honored 7, and the canvas offered 6. `graphQL` was honored by the interpreter
 * but had no checkbox, so a capability the engine fully supported was unreachable from the UI — a
 * silent gap, because nothing fails when a checkbox merely doesn't exist.
 *
 * `RETRYABLE_NODE_KINDS` in @naary/dsl is now the single source; the canvas consumes it. This test
 * closes the remaining edge — that the worker actually honors every kind on that list — by
 * inspecting each handler's source for the `retryOverride` identifier, with comments stripped first
 * (see the two traps below). Source inspection is crude, but it tests the real wiring rather than a
 * second list someone has to remember to update — and the alternative, running each node type
 * against a flaky activity, is 7 Temporal e2e specs to assert one line of plumbing each.
 *
 * Two traps, both hit while writing this, which together dictate the matching strategy:
 *   1. swc keeps COMMENTS in `Function.prototype.toString()`, and the handlers that deliberately
 *      don't honor retry say so in prose ("No per-node retryOverride — the write/read split
 *      governs"), so matching the bare name reported codeAgent and integration as honoring it.
 *   2. Matching `retryOverride(` instead then matched NOTHING, because the transform emits
 *      CommonJS interop — `(0, _proxies.retryOverride)(…)` — where the name is followed by `)`.
 * Hence: strip comments, then match the bare identifier. Immune to both, and to whatever call
 * shape the compiler emits next.
 *
 * `branching.e2e.spec.ts` is what proves retry BEHAVES (fails 3×, succeeds on the 4th, and that the
 * default cap of 3 fails the same node). This proves the affordance is WIRED for every kind we
 * advertise. Both matter: behaviour without coverage of the wiring is how graphQL got missed.
 */
/** Comments removed, so only real code counts — see the note above. */
function callsRetryOverride(fn: unknown): boolean {
  if (typeof fn !== "function") return false;
  const code = String(fn)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  return code.includes("retryOverride");
}

describe("per-node retry affordance", () => {
  it("declares only kinds that have a handler at all", () => {
    for (const kind of RETRYABLE_NODE_KINDS) {
      expect(
        NODE_HANDLERS[kind],
        `no handler registered for "${kind}"`,
      ).toBeTypeOf("function");
    }
  });

  it("routes every declared kind through retryOverride", () => {
    const missing = RETRYABLE_NODE_KINDS.filter((kind) => {
      const handler = NODE_HANDLERS[kind];
      return !callsRetryOverride(handler);
    });
    expect(
      missing,
      `RETRYABLE_NODE_KINDS advertises these, but their handlers never call retryOverride — ` +
        `the canvas would show a retry checkbox that does nothing: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  /**
   * The inverse direction, and the one that actually protects users: a handler that honors `retry`
   * while the kind is NOT advertised is a hidden capability (the graphQL bug). A handler that does
   * NOT honor it while being advertised is worse — a checkbox that lies. Either way the two lists
   * must be the same set, so scan every registered handler.
   */
  it("advertises every kind whose handler honors retry — no hidden capabilities", () => {
    const honoring = Object.entries(NODE_HANDLERS)
      .filter(([, h]) => callsRetryOverride(h))
      .map(([kind]) => kind)
      .sort();
    expect(honoring).toEqual([...RETRYABLE_NODE_KINDS].sort());
  });

  /**
   * Membership rule, asserted rather than left to a comment: a retry must not be able to double-act.
   * These are the at-most-once nodes (`maximumAttempts: 1` in proxies.ts) and adding any of them to
   * the list would turn one retry into duplicate writes, duplicate emails, or a second paid agent run.
   */
  it("never advertises an at-most-once node", () => {
    // These must be real node kinds, asserted below — `mapNode` used to be in this list and is
    // only an ACTIVITY proxy name, never a NodeType, so its assertion was vacuously true. A
    // safety check that cannot fail is worse than no check, so each name is verified to be a
    // registered kind first.
    const atMostOnce = [
      "sqlExec",
      "sendEmail",
      "code",
      "codeAgent",
      // The node kind is `integration` — `callIntegration`/`callIntegrationWrite` are the
      // activity names. Its write side is what makes it at-most-once.
      "integration",
    ];
    for (const kind of atMostOnce) {
      // Non-vacuity: if the name isn't a registered kind, the exclusion below proves nothing.
      expect(
        NODE_HANDLERS,
        `"${kind}" is not a registered node kind, so excluding it asserts nothing`,
      ).toHaveProperty(kind);
      expect(
        RETRYABLE_NODE_KINDS as readonly string[],
        `"${kind}" is at-most-once — retrying it risks a double effect`,
      ).not.toContain(kind);
    }
  });
});
