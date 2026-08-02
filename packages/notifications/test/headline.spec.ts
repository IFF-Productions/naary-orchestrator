// CHARACTERIZATION guard for `notificationHeadline` (#1059).
//
// Not a red-first spec — it is deliberately written to pass on the code BEFORE the change, and
// its job is to stay green through it. #1059 turns the headline into a medium-independent MODEL
// with one renderer per medium (Slack mrkdwn / plain text / HTML) so the email body can reuse the
// sentence Slack already says instead of growing a second copy of it. That refactor is only safe
// if the Slack rendering comes out BYTE-IDENTICAL, and today only some kinds are pinned:
// run_failed, budget_threshold and promotion assert their section text, while `approval_pending`
// — including the two-line ESCALATION flavor, the shape most likely to shift under a model
// refactor — was pinned nowhere at all.
//
// So: every kind × flavor, exact strings, in one place. If a future refactor moves a space or
// drops a marker, this goes red before Slack does.
import { describe, expect, it } from "vitest";
import {
  type NotificationInput,
  notificationHeadline,
  notificationHeadlineHtml,
  notificationHeadlineText,
} from "../src";

const APPROVAL: NotificationInput = {
  kind: "approval_pending",
  workflowId: "wh-t1-9a8b7c",
  workflowKey: "refund-triage",
  title: "Refund over $500 needs a human",
};

const FAILED: NotificationInput = {
  kind: "run_failed",
  workflowId: "exec-t-demo-9f44d033-8bac-4418-98ec-5550172e7100",
  workflowKey: "invoice-sync",
  detail: "Agent call timed out after 60s",
  errorType: "AGENT_TIMEOUT",
  failedNodeId: "summarize",
};

const BUDGET: NotificationInput = {
  kind: "budget_threshold",
  workflowId: "wh-t1-9a8b7c",
  thresholdPct: 80,
  capUsd: 400,
  spendUsd: 321.4,
};

const PROMOTION: NotificationInput = {
  kind: "promotion",
  workflowId: "invoice-sync",
  workflowKey: "invoice-sync",
  fromEnv: "sandbox",
  toEnv: "prod",
  version: 7,
};

const FIX_PROPOSAL: NotificationInput = {
  kind: "fix_proposal",
  workflowId: "pagerduty-triage",
  workflowKey: "pagerduty-triage",
  title: "pagerduty: Missing required header 'From'",
};

describe("notificationHeadline — the Slack mrkdwn rendering, pinned per kind", () => {
  it("approval_pending: name — gate title", () => {
    expect(notificationHeadline(APPROVAL)).toBe(
      "*refund-triage* — Refund over $500 needs a human",
    );
  });

  it("approval_pending reminder: identical to the initial pause (the HEADER carries the flavor)", () => {
    expect(
      notificationHeadline({
        ...APPROVAL,
        flavor: "reminder",
        reminderIndex: 2,
      }),
    ).toBe("*refund-triage* — Refund over $500 needs a human");
  });

  it("approval_pending escalation: the target gets its OWN line, bold — not a label/value", () => {
    expect(
      notificationHeadline({
        ...APPROVAL,
        flavor: "escalation",
        escalateTo: "@ops-oncall",
      }),
    ).toBe(
      "*refund-triage* — Refund over $500 needs a human\nEscalated to *@ops-oncall*",
    );
  });

  it("approval_pending with no title: just the name", () => {
    expect(notificationHeadline({ ...APPROVAL, title: undefined })).toBe(
      "*refund-triage*",
    );
  });

  it("run_failed: name — `type` at step `node`, reason on line 2", () => {
    expect(notificationHeadline(FAILED)).toBe(
      "*invoice-sync* — `AGENT_TIMEOUT` at step `summarize`\nAgent call timed out after 60s",
    );
  });

  it("run_failed with a short reason and no type: the reason rides the first line", () => {
    expect(
      notificationHeadline({
        ...FAILED,
        errorType: undefined,
        failedNodeId: undefined,
        detail: "budget_exceeded",
      }),
    ).toBe("*invoice-sync* — budget_exceeded");
  });

  it("run_failed with nothing known: the workflow, italic when unnamed", () => {
    expect(
      notificationHeadline({
        kind: "run_failed",
        workflowId: "exec-1",
        detail: "failed",
      }),
    ).toBe("_an unnamed workflow_");
  });

  it("budget_threshold: the spend sentence + what does NOT stop", () => {
    expect(notificationHeadline(BUDGET)).toBe(
      "Workspace spend is *$321.40* of the *$400.00* monthly cap.\nRuns keep running until the cap is reached.",
    );
  });

  it("budget_threshold with only a cap", () => {
    expect(notificationHeadline({ ...BUDGET, spendUsd: undefined })).toBe(
      "Workspace spend crossed the alert threshold on the *$400.00* monthly cap.\nRuns keep running until the cap is reached.",
    );
  });

  it("promotion: name is now vN in env", () => {
    expect(notificationHeadline(PROMOTION)).toBe(
      "*invoice-sync* is now *v7* in *prod*.",
    );
  });

  it("fix_proposal: name — what it fixes + the guarantee on line 2", () => {
    expect(notificationHeadline(FIX_PROPOSAL)).toBe(
      "*pagerduty-triage* — pagerduty: Missing required header 'From'\nNothing is applied until you approve it.",
    );
  });

  it("neutralizes a backtick in a user value so it can't open a code span", () => {
    // codeText, not bare slackEscape: a stray backtick would swallow the rest of the line.
    expect(
      notificationHeadline({ ...APPROVAL, workflowKey: "we`ird & <b>" }),
    ).toBe("*weʼird &amp; &lt;b&gt;* — Refund over $500 needs a human");
  });
});

// The two NEW renderings (#1059). Same model, different medium — this is what lets the email
// body reuse the sentence instead of growing a second copy of it.
describe("notificationHeadlineText — the plain-text rendering", () => {
  it("carries NO markers and NO escaping — a text/plain body is not markup", () => {
    expect(notificationHeadlineText(APPROVAL)).toBe(
      "refund-triage — Refund over $500 needs a human",
    );
    expect(notificationHeadlineText(FAILED)).toBe(
      "invoice-sync — AGENT_TIMEOUT at step summarize\nAgent call timed out after 60s",
    );
    expect(notificationHeadlineText(BUDGET)).toBe(
      "Workspace spend is $321.40 of the $400.00 monthly cap.\nRuns keep running until the cap is reached.",
    );
    expect(notificationHeadlineText(PROMOTION)).toBe(
      "invoice-sync is now v7 in prod.",
    );
  });

  it("leaves &, < and a backtick exactly as the user typed them", () => {
    // The bug a mrkdwn→text converter would ship: `&amp;` and `ʼ` are SLACK artifacts, and a
    // text/plain body that shows them is showing the reader our escaping, not their data.
    expect(
      notificationHeadlineText({ ...APPROVAL, workflowKey: "we`ird & <b>" }),
    ).toBe("we`ird & <b> — Refund over $500 needs a human");
  });

  it("says an unnamed workflow without italic underscores", () => {
    expect(
      notificationHeadlineText({ kind: "run_failed", workflowId: "exec-1" }),
    ).toBe("an unnamed workflow");
  });
});

describe("notificationHeadlineHtml — the HTML rendering", () => {
  it("uses real HTML emphasis, not asterisks", () => {
    const html = notificationHeadlineHtml(APPROVAL);
    expect(html).toBe(
      "<strong>refund-triage</strong> — Refund over $500 needs a human",
    );
    expect(html).not.toContain("*");
  });

  it("breaks lines with <br />, never a raw newline", () => {
    // A two-line headline whose newline survives into HTML renders as one run-on line.
    const html = notificationHeadlineHtml(BUDGET);
    expect(html).toBe(
      "Workspace spend is <strong>$321.40</strong> of the <strong>$400.00</strong> monthly cap.<br />Runs keep running until the cap is reached.",
    );
    expect(html).not.toContain("\n");
  });

  it("renders code spans as <code>, not backticks", () => {
    const html = notificationHeadlineHtml(FAILED);
    expect(html).toContain(">AGENT_TIMEOUT</code>");
    expect(html).toContain(">summarize</code>");
    expect(html).not.toContain("`");
  });

  it("escapes user values for HTML — and only ONCE (no &amp;amp;)", () => {
    const html = notificationHeadlineHtml({
      ...APPROVAL,
      workflowKey: `<img src=x onerror="pwn()"> & 'q'`,
    });
    expect(html).not.toContain("<img");
    expect(html).toContain(
      "&lt;img src=x onerror=&quot;pwn()&quot;&gt; &amp; &#39;q&#39;",
    );
    expect(html).not.toContain("&amp;amp;");
    // A backtick is not special in HTML, so it survives verbatim — unlike the Slack rendering,
    // which has to neutralize it. Proof the two renderers are independent, not chained.
    expect(
      notificationHeadlineHtml({ ...APPROVAL, workflowKey: "we`ird" }),
    ).toBe("<strong>we`ird</strong> — Refund over $500 needs a human");
  });

  it("renders the unnamed-workflow fallback as <em>", () => {
    expect(
      notificationHeadlineHtml({ kind: "run_failed", workflowId: "exec-1" }),
    ).toBe("<em>an unnamed workflow</em>");
  });
});
