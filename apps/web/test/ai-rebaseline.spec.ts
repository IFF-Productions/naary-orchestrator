// Does a landed AI generation reset the unsaved-changes baseline?
//
// It depended on the MODE, and got the answer wrong for edits. #874 gave the AI panel an edit mode
// and #919 gave the canvas an unsaved-changes guard; each was right alone, and nothing tested them
// together. Composed, a landed EDIT re-baselined — so the AI's work was marked clean the instant
// it appeared, and leaving the canvas discarded it with no prompt.
//
// It also silently breaks "Review changes", which diffs the live canvas against that baseline: a
// baseline that moves on every edit reports "no changes" at the exact moment there is most to
// review.
import { describe, expect, it } from "vitest";
import {
  needsFreshSession,
  sessionBindingStale,
  shouldRebaselineAfterGeneration,
} from "../src/screens/canvas/useAiBuilder";

describe("shouldRebaselineAfterGeneration", () => {
  it("re-baselines a CREATE — it presents a graph, like opening a template", () => {
    expect(shouldRebaselineAfterGeneration("create")).toBe(true);
  });

  it("does NOT re-baseline an EDIT — that is unsaved work against a saved workflow", () => {
    // The regression. If this flips to true, an AI edit becomes discardable without a prompt AND
    // the review panel goes blank.
    expect(shouldRebaselineAfterGeneration("edit")).toBe(false);
  });

  // The panel is multi-turn now (#1003), which makes the rule above STRICTER rather than looser:
  // only the turn that created the draft is a create, and the panel flips itself to "edit"
  // afterwards, so a from-scratch chat re-baselines exactly once and every refinement after it is
  // unsaved work the guard must still catch.
  it("re-baselines only the first turn of a from-scratch chat", () => {
    const turns = ["create", "edit", "edit"] as const;
    expect(turns.map(shouldRebaselineAfterGeneration)).toEqual([
      true,
      false,
      false,
    ]);
  });
});

/**
 * "Start a new one" starts a new SESSION, not just a new graph.
 *
 * A session carries the `workflowKey` it was opened against. Reusing an edit session for an
 * invention would leave a session bound to workflow A whose draft is not A — and resuming that
 * from the Build with AI screen publishes the invention as A's next version. That is #874 arriving
 * by the back door, so a create never inherits a binding.
 */
describe("needsFreshSession", () => {
  it("starts over when a create follows an existing conversation", () => {
    expect(needsFreshSession("create", true)).toBe(true);
  });

  it("has nothing to discard when a create is the first turn", () => {
    expect(needsFreshSession("create", false)).toBe(false);
  });

  it("keeps the conversation for an edit — that IS the multi-turn refinement", () => {
    expect(needsFreshSession("edit", true)).toBe(false);
    expect(needsFreshSession("edit", false)).toBe(false);
  });
});

/**
 * The canvas moving out from under a live session.
 *
 * `needsFreshSession` covers the case the user ASKS for. This covers the ones they don't: /app/canvas
 * is a sibling of /app, not a child, so AppShell's `pathname|env` key never remounts it — opening
 * another workflow only rewrites `?key=`, and switching environment changes nothing at all. Each
 * turn still edits the graph the canvas sends, so the model does the right work; but the RESULT is
 * written onto a session stamped with the previous workflow, which then reads "editing A" in the
 * resume list while holding B's graph.
 */
describe("sessionBindingStale", () => {
  const env = "prod";

  it("is never stale with no session yet", () => {
    expect(sessionBindingStale(null, { workflowKey: "a", env })).toBe(false);
  });

  it("goes stale when the canvas opens a DIFFERENT workflow", () => {
    // The bug: resuming this session from Build with AI would publish B's graph as A's next
    // version — #874's destination, reached without anyone navigating away from the canvas.
    expect(
      sessionBindingStale(
        { workflowKey: "wf-a", env },
        { workflowKey: "wf-b", env },
      ),
    ).toBe(true);
  });

  it("goes stale when a bound session's workflow is replaced by a blank canvas", () => {
    expect(
      sessionBindingStale(
        { workflowKey: "wf-a", env },
        { workflowKey: "", env },
      ),
    ).toBe(true);
  });

  it("goes stale on an ENVIRONMENT switch, bound or not", () => {
    // The session carries its own environmentId and the turn endpoint prefers it, so without this
    // a session opened in sandbox keeps generating against sandbox's keys and connections however
    // the env chip reads.
    expect(
      sessionBindingStale(
        { workflowKey: "wf-a", env: "sandbox" },
        { workflowKey: "wf-a", env: "prod" },
      ),
    ).toBe(true);
    expect(
      sessionBindingStale(
        { workflowKey: "", env: "sandbox" },
        { workflowKey: "", env: "prod" },
      ),
    ).toBe(true);
  });

  it("survives the from-scratch bookkeeping an UNBOUND session does to itself", () => {
    // A create opens an unbound session, then blanks `workflowKey` on the canvas; saving the draft
    // later fills it in with a brand-new key. Neither is a reason to throw away the conversation
    // that produced the draft — and an unbound session is safe by construction, because resuming
    // it creates a workflow rather than overwriting one.
    const bound = { workflowKey: "", env };
    expect(sessionBindingStale(bound, { workflowKey: "", env })).toBe(false);
    expect(sessionBindingStale(bound, { workflowKey: "new-flow", env })).toBe(
      false,
    );
  });

  it("stays put across turns on the same workflow — the ordinary case", () => {
    expect(
      sessionBindingStale(
        { workflowKey: "wf-a", env },
        { workflowKey: "wf-a", env },
      ),
    ).toBe(false);
  });
});
