import { describe, expect, it } from "vitest";
import {
  RETURNED_FAILURE_STATUSES,
  RETURNED_TERMINAL_STATUSES,
  TERMINAL_STATUSES,
} from "../src/index";
// Cross-boundary imports, test-only. These two copies CANNOT import this package (see below), so
// reaching into them from here is the only way to check they still agree.
import { TERMINAL_STATUSES as CLI_TERMINAL } from "../../cli/src/watch";
import { isTerminal as webIsTerminal } from "../../../apps/web/src/lib/run-status";

/**
 * #805 — "terminal" was answered by five separate lists across four packages, one of which
 * disagreed. Three are now named for the different questions they answer; two copies REMAIN, for
 * reasons that aren't going away:
 *
 *   - `@naary/cli` is deliberately dependency-free — "Node built-ins only; imports NO server code"
 *     (its package.json description). Adding a workspace dep to share a Set would cost more than
 *     the duplication.
 *   - `apps/web` can't import this module at all: it calls `defineSignal` at load, so a browser
 *     bundle importing it would pull in the Temporal SDK.
 *
 * So the duplication is deliberate and this file is the thing that makes it safe. If it fails,
 * update the copy — don't relax the test.
 */

/** Statuses in the ExecutionStatus union that are explicitly NOT terminal — a run in any of these
 *  is still going. Listed rather than derived so that adding a status to the union forces a
 *  decision here instead of silently defaulting to "not terminal". */
const NON_TERMINAL = [
  "running",
  "awaiting_approval",
  "awaiting_webhook",
  "awaiting_budget",
];

describe("the three terminal-status sets are the shapes they claim to be", () => {
  it("returned terminals are a strict subset of all terminals", () => {
    for (const s of RETURNED_TERMINAL_STATUSES) {
      expect(TERMINAL_STATUSES.has(s)).toBe(true);
    }
    expect(RETURNED_TERMINAL_STATUSES.size).toBeLessThan(
      TERMINAL_STATUSES.size,
    );
  });

  /**
   * The difference is exactly the Temporal close reasons. This is the assertion that documents WHY
   * the worker's set is narrower — it isn't a copy that drifted, it's "what a workflow can report"
   * versus "how a run can end".
   */
  it("the difference is precisely the Temporal-imposed statuses", () => {
    const onlyInAll = [...TERMINAL_STATUSES].filter(
      (s) => !RETURNED_TERMINAL_STATUSES.has(s),
    );
    expect(onlyInAll.sort()).toEqual(["canceled", "terminated", "timed_out"]);
  });

  it("failure statuses are returned terminals that aren't success", () => {
    for (const s of RETURNED_FAILURE_STATUSES) {
      expect(RETURNED_TERMINAL_STATUSES.has(s)).toBe(true);
    }
    expect(RETURNED_FAILURE_STATUSES.has("completed")).toBe(false);
    // `failed` is excluded on purpose: the failure path WRITES that status after already knowing
    // it threw, and the workflow tests `threw !== undefined` separately.
    expect(RETURNED_FAILURE_STATUSES.has("failed")).toBe(false);
  });

  it("no non-terminal status is in any of them", () => {
    for (const s of NON_TERMINAL) {
      expect(TERMINAL_STATUSES.has(s)).toBe(false);
      expect(RETURNED_TERMINAL_STATUSES.has(s)).toBe(false);
      expect(RETURNED_FAILURE_STATUSES.has(s)).toBe(false);
    }
  });
});

describe("the copies that can't import this module still agree", () => {
  it("@naary/cli's watch list matches, exactly", () => {
    expect([...CLI_TERMINAL].sort()).toEqual([...TERMINAL_STATUSES].sort());
  });

  /**
   * Web's set is module-private (only `isTerminal` is exported), so this checks BEHAVIOUR — and in
   * BOTH directions. One direction alone would pass if the SPA's set had grown a status the control
   * plane doesn't consider terminal, which would strand a live run as finished in the UI.
   */
  it("the SPA agrees on what is terminal, and on what isn't", () => {
    for (const s of TERMINAL_STATUSES) {
      expect(webIsTerminal(s), `SPA should treat "${s}" as terminal`).toBe(
        true,
      );
    }
    for (const s of NON_TERMINAL) {
      expect(webIsTerminal(s), `SPA should treat "${s}" as live`).toBe(false);
    }
  });
});
