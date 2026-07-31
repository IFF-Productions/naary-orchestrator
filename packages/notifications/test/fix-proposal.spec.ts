// Self-healing fix-proposal notifications (Phase 2): a CHANGE to a workflow is waiting for a
// human. Not a run outcome — the failure was reported separately, so there is no run to link to
// and none of the run-scoped affordances apply.
//
// The two things these tests pin are both about not alarming or misleading the reader:
//   · the message states that nothing has been applied, because someone seeing "a fix is proposed
//     for your production workflow" in Slack should not have to wonder whether it already changed;
//   · there are NO Approve/Reject buttons, unlike a run approval. Approving writes a new version
//     and that decision is made against the DIFF, which a chat message cannot show.
import { describe, expect, it } from "vitest";
import {
  type NotificationInput,
  type NotificationLinks,
  notificationActions,
  notificationHeader,
  notificationText,
} from "../src";

const INPUT: NotificationInput = {
  kind: "fix_proposal",
  // The WORKFLOW KEY — there is no run here, the same contract `promotion` uses.
  workflowId: "pagerduty-triage",
  workflowKey: "pagerduty-triage",
  title: "pagerduty: Missing required header 'From'",
};

const LINKS: NotificationLinks = {
  approvalUrl: "https://app.example.com/app/fix-proposals",
  workflowUrl: "https://app.example.com/app/workflows/pagerduty-triage",
};

describe("fix_proposal notification", () => {
  it("says what it is without claiming a machine did it", () => {
    // The reader's decision is about the CHANGE; that a model drafted it is secondary.
    expect(notificationHeader(INPUT)).toContain("fix is proposed");
  });

  it("states that nothing has been applied", () => {
    // The guarantee belongs IN the message. Someone reading this on their phone should not have
    // to open the app to find out whether their production workflow already changed.
    const text = notificationText(INPUT, LINKS);
    expect(text).toContain("Nothing is applied until you approve it");
    expect(text).toContain("pagerduty-triage");
    expect(text).toContain(LINKS.approvalUrl as string);
  });

  it("carries the failure it is proposing a fix for", () => {
    expect(notificationText(INPUT, LINKS)).toContain("Missing required header");
  });

  it("offers ONE action — go and look at the diff", () => {
    const actions = notificationActions(INPUT, LINKS);
    expect(actions).toHaveLength(1);
    expect(actions[0].url).toBe(LINKS.approvalUrl);
    // Emphatically NOT approve/reject: a chat message cannot show the diff, and approving
    // without seeing it is the one thing this whole feature is built to avoid.
    const labels = actions.map((a) => a.label.toLowerCase()).join(" ");
    expect(labels).not.toMatch(/approve|reject/);
  });

  it("falls back to the workflow when there is no inbox link", () => {
    // APP_BASE_URL unset — the notification still names somewhere useful rather than nowhere.
    const actions = notificationActions(INPUT, {
      workflowUrl: LINKS.workflowUrl,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0].url).toBe(LINKS.workflowUrl);
  });

  it("does not offer a run link — there is no run", () => {
    // The run that failed reported itself separately; pointing at it here would send the reader
    // to the wrong screen for the decision they have to make.
    const actions = notificationActions(INPUT, {
      ...LINKS,
      runUrl: "https://app.example.com/app/runs/exec-1",
    });
    expect(actions.map((a) => a.url)).not.toContain(
      "https://app.example.com/app/runs/exec-1",
    );
  });
});
