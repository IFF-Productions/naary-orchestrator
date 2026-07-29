import { describe, expect, it } from "vitest";
import { resumeButtonState } from "../src/screens/app/run-detail/resume-state";

/**
 * docs/design/RESUME-FROM-FAILED-NODE.md §6. Most failed runs are NOT resumable, so the copy that
 * explains WHY is the main thing this control does — pinned here rather than only ever read by
 * someone staring at a greyed-out button.
 */
describe("resumeButtonState", () => {
  it("disables while the eligibility check is in flight", () => {
    const s = resumeButtonState(undefined);
    expect(s.disabled).toBe(true);
    expect(s.title).toMatch(/Checking/);
  });

  /** Disabled, not hidden: the run IS failed, so hiding would look like the feature doesn't exist. */
  it("disables with a retry hint when the check itself failed", () => {
    const s = resumeButtonState(null);
    expect(s.disabled).toBe(true);
    expect(s.title).toMatch(/Reload/);
  });

  it("shows the API's reason verbatim when the run can't be resumed", () => {
    const s = resumeButtonState({
      resumable: false,
      reason: "inside_item_region",
      detail: "The failure happened inside a per-item region.",
    });
    expect(s.disabled).toBe(true);
    expect(s.title).toBe("The failure happened inside a per-item region.");
  });

  /** A refusal added server-side must still say something, even with no `detail`. */
  it("falls back to the machine reason when there is no detail", () => {
    const s = resumeButtonState({
      resumable: false,
      reason: "parallel_fanout",
    });
    expect(s.title).toContain("parallel_fanout");
  });

  it("enables for a resumable run and names the node it will restart at", () => {
    const s = resumeButtonState({ resumable: true, failedNodeId: "http-1" });
    expect(s.disabled).toBe(false);
    expect(s.needsConfirm).toBe(false);
    expect(s.title).toContain("http-1");
    expect(s.title).toMatch(/nothing earlier runs again/);
  });

  /** The one case that must interrupt: re-running the failed node could duplicate its effect. */
  it("requires confirmation when the failing node may already have taken effect", () => {
    const s = resumeButtonState({
      resumable: true,
      failedNodeId: "email-1",
      warnings: ["at_most_once_node"],
      warningText:
        'The failing "sendEmail" node may already have taken effect.',
    });
    expect(s.disabled).toBe(false);
    expect(s.needsConfirm).toBe(true);
    expect(s.confirmBody).toContain("sendEmail");
    // The body is the WARNING only. The question lives in the dialog's title and its accept
    // button ("Resume anyway"), so repeating it here said the same thing three times — and the
    // "\n\n" that separated it collapsed anyway, since the body renders as flow content.
    expect(s.confirmBody).not.toMatch(/Resume anyway/);
    expect(s.confirmBody).not.toContain("\n");
  });

  it("disables while a resume is in flight", () => {
    const s = resumeButtonState({ resumable: true, failedNodeId: "n" }, true);
    expect(s.disabled).toBe(true);
    expect(s.title).toMatch(/Resuming/);
  });
});
