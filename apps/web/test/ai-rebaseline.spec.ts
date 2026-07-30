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
import { shouldRebaselineAfterGeneration } from "../src/screens/canvas/useAiBuilder";

describe("shouldRebaselineAfterGeneration", () => {
  it("re-baselines a CREATE — it presents a graph, like opening a template", () => {
    expect(shouldRebaselineAfterGeneration("create")).toBe(true);
  });

  it("does NOT re-baseline an EDIT — that is unsaved work against a saved workflow", () => {
    // The regression. If this flips to true, an AI edit becomes discardable without a prompt AND
    // the review panel goes blank.
    expect(shouldRebaselineAfterGeneration("edit")).toBe(false);
  });
});
