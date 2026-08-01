// The run-detail approval hero shows the gate's prompt rendered against THIS run (#1019).
//
// This surface is not the API's: the hero reads the paused humanApproval node's config straight
// off the run's graph snapshot in the browser, so it needed its own fix — and needs its own guard
// that it agrees with the inbox, the public approve/reject page and the Slack/Teams/email
// notification, all of which render through the same `resolvePromptText`.
import { describe, expect, it } from "vitest";
import { approvalPromptView } from "../src/screens/app/run-detail/run-view-model";

// A ctx as the state query returns it, carrying `$secrets` deliberately — an absent key would
// make the "stays literal" assertion below vacuous.
const CTX = {
  $vars: { REGION: "eu-central" },
  $secrets: { GH_TOKEN: "ghp-super-secret-value" },
  start: { issueNumber: 42, owner: "IFF-Productions", repo: "naary" },
};

const GATE = {
  title: "Approve automated fix for issue #{{ start.issueNumber }}",
  instructions:
    "Fix for {{ start.owner }}/{{ start.repo }} in {{ $vars.REGION }}. " +
    "Token {{ $secrets.GH_TOKEN }}. Reviewer: {{ start.reviewer }}.",
  timeoutHours: 24,
  approvers: { emails: ["sam@acme.io"] },
};

describe("approvalPromptView", () => {
  it("renders the reported prompt against the run", () => {
    const view = approvalPromptView(GATE, CTX);
    expect(view.title).toBe("Approve automated fix for issue #42");
    expect(view.instructions).toContain("IFF-Productions/naary");
    expect(view.instructions).toContain("eu-central"); // $vars resolve
  });

  it("keeps $secrets literal and never leaks the value", () => {
    const view = approvalPromptView(GATE, CTX);
    expect(JSON.stringify(view)).not.toContain("ghp-super-secret-value");
    expect(view.instructions).toContain("{{ $secrets.GH_TOKEN }}");
  });

  it("keeps an unresolvable reference legible instead of blanking it", () => {
    const view = approvalPromptView(GATE, CTX);
    expect(view.instructions).toContain("Reviewer: {{ start.reviewer }}.");
    expect(view.instructions).not.toContain("undefined");
  });

  it("passes every other config fact through untouched", () => {
    const view = approvalPromptView(GATE, CTX);
    expect(view.timeoutHours).toBe(24);
    expect(view.approvers).toEqual({ emails: ["sam@acme.io"] });
  });

  it("preserves ABSENCE — an untitled gate stays untitled, so the hero still hides the block", () => {
    expect(approvalPromptView({}, CTX)).toEqual({});
    expect(approvalPromptView(undefined, CTX)).toEqual({});
    expect("title" in approvalPromptView({ instructions: "hi" }, CTX)).toBe(
      false,
    );
  });

  it("degrades to the authored text when there is no ctx (state not loaded / closed run)", () => {
    expect(approvalPromptView(GATE, undefined).title).toBe(GATE.title);
    expect(approvalPromptView(GATE, {}).title).toBe(GATE.title);
  });
});
