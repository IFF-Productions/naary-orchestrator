// Email rendering (REDESIGN-FUNCTIONALITY-GAPS.md Slice 4): subject + plain-text AND
// HTML bodies per kind/flavor. Decide-in-place for email = the SAME signed approve/
// reject links the Slack buttons carry — asserted against notificationActions so the
// URLs literally cannot differ.
import { describe, expect, it } from "vitest";
import {
  htmlEscape,
  type NotificationInput,
  type NotificationLinks,
  notificationActions,
  notificationEmail,
  notificationHeadlineHtml,
  notificationHeadlineText,
} from "../src";

const LINKS: NotificationLinks = {
  approvalUrl: "https://app.example.com/approve/wf-1?token=abc&exp=123",
  runUrl: "https://app.example.com/app/runs/wf-1",
  usageUrl: "https://app.example.com/app/billing",
  workflowUrl: "https://app.example.com/app/workflows/poller",
};

const APPROVAL: NotificationInput = {
  kind: "approval_pending",
  workflowId: "wf-1",
  workflowKey: "poller",
  title: "Ship it?",
};

const FAILED: NotificationInput = {
  kind: "run_failed",
  workflowId: "exec-t1-9f44d033",
  workflowKey: "invoice-sync",
  detail: "Agent call timed out after 60s",
  errorType: "AGENT_TIMEOUT",
  failedNodeId: "summarize",
};

/**
 * #1059 — the gap #992 left. `notificationEmail` went header → fact table → buttons and never
 * called the headline, so the ONE channel with no chat context around it said everything as a
 * form. Both halves of the mail are asserted: a headline that exists only in the HTML is half a
 * fix, because a text/plain reader (and every "show original" / plaintext client) sees the other.
 *
 * Every expectation below is COMPUTED from `notificationHeadlineText`/`Html` rather than
 * transcribing today's sentence — the point is that the email reuses the ONE headline, so
 * rewording it must not turn these red, while a second hand-rolled copy must.
 */
describe("notificationEmail — the prose headline (#1059)", () => {
  const KINDS: [string, NotificationInput][] = [
    ["approval_pending", APPROVAL],
    [
      "approval_pending/reminder",
      { ...APPROVAL, flavor: "reminder", reminderIndex: 2 },
    ],
    [
      "approval_pending/escalation",
      { ...APPROVAL, flavor: "escalation", escalateTo: "@ops-oncall" },
    ],
    ["run_failed", FAILED],
    [
      "budget_threshold",
      {
        kind: "budget_threshold",
        workflowId: "wh-crossing",
        thresholdPct: 80,
        capUsd: 400,
        spendUsd: 321.4,
      },
    ],
    [
      "promotion",
      {
        kind: "promotion",
        workflowId: "poller",
        workflowKey: "poller",
        fromEnv: "sandbox",
        toEnv: "prod",
        version: 7,
      },
    ],
    [
      "fix_proposal",
      {
        kind: "fix_proposal",
        workflowId: "poller",
        workflowKey: "poller",
        title: "http: Missing required header 'From'",
      },
    ],
  ];

  it.each(KINDS)("%s: both bodies lead with the headline", (_name, input) => {
    const mail = notificationEmail(input, LINKS);
    expect(mail.text).toContain(notificationHeadlineText(input));
    expect(mail.html).toContain(notificationHeadlineHtml(input));
  });

  it.each(KINDS)(
    "%s: the headline comes BEFORE the facts, not after",
    (_name, input) => {
      const mail = notificationEmail(input, LINKS);
      // A prose line under the table is not a headline.
      expect(mail.text.indexOf(notificationHeadlineText(input))).toBeLessThan(
        mail.text.indexOf("\n\n"),
      );
      expect(mail.html.indexOf(notificationHeadlineHtml(input))).toBeLessThan(
        mail.html.indexOf("<table"),
      );
    },
  );

  it("the HTML headline never leaks Slack markers into the mail", () => {
    const mail = notificationEmail(FAILED, LINKS);
    expect(mail.html).toContain("<strong>invoice-sync</strong>");
    expect(mail.html).not.toContain("*invoice-sync*");
    expect(mail.html).not.toContain("`AGENT_TIMEOUT`");
  });

  it("the text headline never leaks Slack ESCAPES into the mail", () => {
    // The failure mode of converting mrkdwn to text instead of rendering the model twice.
    const mail = notificationEmail({ ...FAILED, workflowKey: "a & b" }, LINKS);
    expect(mail.text).toContain("a & b —");
    expect(mail.text).not.toContain("&amp;");
    expect(mail.text).not.toContain("*");
  });

  it("a two-line headline breaks with <br /> in the HTML half", () => {
    const mail = notificationEmail(FAILED, LINKS);
    expect(mail.html).toContain("<br />Agent call timed out after 60s");
  });
});

describe("notificationEmail — the subject line (#1059)", () => {
  it("run_failed says WHAT failed, not just that something did", () => {
    expect(notificationEmail(FAILED, LINKS).subject).toBe(
      "❌ Run failed: invoice-sync — AGENT_TIMEOUT at step summarize",
    );
  });

  it("approval_pending names the gate, so the inbox says what is waiting", () => {
    expect(notificationEmail(APPROVAL, LINKS).subject).toBe(
      "⏳ Approval needed: poller — Ship it?",
    );
  });

  it("keeps the flavor marker in front of the specifics", () => {
    expect(
      notificationEmail(
        { ...APPROVAL, flavor: "reminder", reminderIndex: 2 },
        LINKS,
      ).subject,
    ).toBe("⏰ Approval reminder #2: poller — Ship it?");
    // Escalation's second headline line (WHO it went to) stays out of the subject.
    expect(
      notificationEmail(
        { ...APPROVAL, flavor: "escalation", escalateTo: "@ops-oncall" },
        LINKS,
      ).subject,
    ).toBe("🚨 Approval escalated: poller — Ship it?");
  });

  it("budget_threshold is unchanged — its header already carries the specific fact", () => {
    expect(
      notificationEmail(
        {
          kind: "budget_threshold",
          workflowId: "wh-crossing",
          thresholdPct: 80,
          capUsd: 400,
          spendUsd: 321.4,
        },
        LINKS,
      ).subject,
    ).toBe("📊 Budget alert — 80% of the monthly cap");
  });

  it("promotion is unchanged — its header already names the target env", () => {
    expect(
      notificationEmail(
        {
          kind: "promotion",
          workflowId: "poller",
          workflowKey: "poller",
          fromEnv: "sandbox",
          toEnv: "prod",
          version: 7,
        },
        LINKS,
      ).subject,
    ).toBe('🚀 Workflow promoted to prod — "poller"');
  });

  it("is bounded — a long gate title is cut, not carried whole", () => {
    const subject = notificationEmail(
      { ...APPROVAL, title: `Refund ${"very ".repeat(60)}large` },
      LINKS,
    ).subject;
    expect(subject.length).toBeLessThanOrEqual(110);
    expect(subject.endsWith("…")).toBe(true);
    // Still front-loads the two things a person scans for.
    expect(subject.startsWith("⏳ Approval needed: poller — Refund very")).toBe(
      true,
    );
  });

  it("inherits the headline's own inline rule for an unbounded error message", () => {
    // A raw thrown message with no ApplicationFailure type is what the headline puts on its
    // SECOND line (too long to read inline), and the subject carries the first. So the subject
    // degrades to exactly what it used to say — the workflow — instead of dragging a page of
    // provider JSON into the inbox. Short reasons DO reach the subject, because the headline
    // inlines those (see "run_failed with a short reason" in headline.spec.ts).
    expect(
      notificationEmail(
        {
          ...FAILED,
          errorType: undefined,
          failedNodeId: undefined,
          detail: "x".repeat(500),
        },
        LINKS,
      ).subject,
    ).toBe("❌ Run failed: invoice-sync");
    expect(
      notificationEmail(
        {
          ...FAILED,
          errorType: undefined,
          failedNodeId: undefined,
          detail: "budget_exceeded",
        },
        LINKS,
      ).subject,
    ).toBe("❌ Run failed: invoice-sync — budget_exceeded");
  });

  it("is a single line — a newline in a subject header is a malformed mail", () => {
    for (const [, input] of [
      ["", FAILED],
      ["", { ...APPROVAL, flavor: "escalation", escalateTo: "@ops" }],
    ] as [string, NotificationInput][]) {
      expect(notificationEmail(input, LINKS).subject).not.toContain("\n");
    }
  });

  it("carries no Slack markup — a subject is plain text", () => {
    const subject = notificationEmail(
      { ...FAILED, workflowKey: "a & b" },
      LINKS,
    ).subject;
    expect(subject).toContain("a & b");
    expect(subject).not.toContain("&amp;");
    expect(subject).not.toContain("*");
    expect(subject).not.toContain("`");
  });

  it("falls back to the event alone when there is no workflow to name", () => {
    expect(
      notificationEmail({ kind: "run_failed", workflowId: "exec-9" }, {})
        .subject,
    ).toBe("❌ Run failed");
  });
});

describe("notificationEmail — approval_pending", () => {
  it("subject names the event + workflow; bodies carry the facts", () => {
    const mail = notificationEmail(APPROVAL, LINKS);
    expect(mail.subject).toBe("⏳ Approval needed: poller — Ship it?");
    expect(mail.text).toContain("Workflow: poller");
    expect(mail.text).toContain("Run: wf-1");
    expect(mail.text).toContain("Awaiting: Ship it?");
    expect(mail.html).toContain("Approval needed");
    expect(mail.html).toContain("Ship it?");
  });

  it("carries the SAME signed approve/reject links as the Slack buttons", () => {
    const mail = notificationEmail(APPROVAL, LINKS);
    const actions = notificationActions(APPROVAL, LINKS);
    const approve = actions.find((a) => a.label.includes("Approve"));
    const reject = actions.find((a) => a.label.includes("Reject"));
    expect(approve?.url).toBe(
      "https://app.example.com/approve/wf-1?token=abc&exp=123&decision=approve",
    );
    // Both bodies carry both decision links verbatim (text) / attribute-escaped (html).
    expect(mail.text).toContain(approve?.url);
    expect(mail.text).toContain(reject?.url);
    expect(mail.html).toContain(htmlEscape(approve?.url ?? ""));
    expect(mail.html).toContain(htmlEscape(reject?.url ?? ""));
    // And the View-run link.
    expect(mail.text).toContain(LINKS.runUrl as string);
  });

  it("omits decision links when no approvalUrl resolves (no fabricated links)", () => {
    const mail = notificationEmail(APPROVAL, {});
    expect(mail.text).not.toContain("Approve:");
    expect(mail.text).not.toContain("http");
    expect(mail.html).not.toContain("<a ");
  });

  it("reminder flavor: subject says reminder #N; decision links stay", () => {
    const mail = notificationEmail(
      { ...APPROVAL, flavor: "reminder", reminderIndex: 2 },
      LINKS,
    );
    expect(mail.subject).toBe("⏰ Approval reminder #2: poller — Ship it?");
    expect(mail.text).toContain("Reminder: #2");
    expect(mail.text).toContain("&decision=approve");
    expect(mail.text).toContain("&decision=reject");
  });

  it("escalation flavor: subject says escalated; target is a fact", () => {
    const mail = notificationEmail(
      { ...APPROVAL, flavor: "escalation", escalateTo: "@ops-oncall" },
      LINKS,
    );
    expect(mail.subject).toBe("🚨 Approval escalated: poller — Ship it?");
    expect(mail.text).toContain("Escalated to: @ops-oncall");
    expect(mail.html).toContain("@ops-oncall");
  });
});

describe("notificationEmail — run_failed", () => {
  it("subject + facts + View-run link", () => {
    const mail = notificationEmail(
      {
        kind: "run_failed",
        workflowId: "wf-9",
        workflowKey: "poller",
        detail: "timed_out",
      },
      LINKS,
    );
    expect(mail.subject).toBe("❌ Run failed: poller — timed_out");
    expect(mail.text).toContain("Reason: timed_out");
    expect(mail.text).toContain(`View run: ${LINKS.runUrl}`);
    expect(mail.html).toContain("timed_out");
    // No decision links on a failure.
    expect(mail.text).not.toContain("&decision=");
  });

  it("without a workflowKey the subject is just the event", () => {
    const mail = notificationEmail(
      { kind: "run_failed", workflowId: "wf-9" },
      {},
    );
    expect(mail.subject).toBe("❌ Run failed");
  });
});

describe("notificationEmail — budget_threshold", () => {
  it("subject carries the pct; facts carry cap/spend; usage link is the one action", () => {
    const mail = notificationEmail(
      {
        kind: "budget_threshold",
        workflowId: "wh-crossing",
        thresholdPct: 80,
        capUsd: 400,
        spendUsd: 321.4,
      },
      LINKS,
    );
    expect(mail.subject).toBe("📊 Budget alert — 80% of the monthly cap");
    expect(mail.text).toContain("Threshold: 80%");
    expect(mail.text).toContain("Monthly cap: $400.00");
    expect(mail.text).toContain("Spend (incl. reserved): $321.40");
    expect(mail.text).toContain(`View usage & budgets: ${LINKS.usageUrl}`);
    // Tenant-scoped: no run/approve links.
    expect(mail.text).not.toContain("View run");
    expect(mail.text).not.toContain("&decision=");
  });
});

describe("notificationEmail — promotion", () => {
  it("subject names the target env; facts carry from/to/version; workflow link", () => {
    const mail = notificationEmail(
      {
        kind: "promotion",
        workflowId: "poller",
        workflowKey: "poller",
        fromEnv: "sandbox",
        toEnv: "prod",
        version: 7,
      },
      LINKS,
    );
    expect(mail.subject).toBe('🚀 Workflow promoted to prod — "poller"');
    expect(mail.text).toContain("From: sandbox");
    expect(mail.text).toContain("To: prod");
    expect(mail.text).toContain("Version: v7");
    expect(mail.text).toContain(`View workflow: ${LINKS.workflowUrl}`);
    expect(mail.html).toContain("prod");
  });
});

describe("notificationEmail — HTML safety + determinism", () => {
  it("escapes user values in the HTML body (no markup injection)", () => {
    const mail = notificationEmail(
      {
        kind: "run_failed",
        workflowId: "wf-1",
        workflowKey: `<img src=x onerror="pwn()">`,
        detail: `a & b "c" 'd'`,
      },
      LINKS,
    );
    expect(mail.html).not.toContain(`<img src=x`);
    expect(mail.html).toContain("&lt;img src=x onerror=&quot;pwn()&quot;&gt;");
    expect(mail.html).toContain("a &amp; b &quot;c&quot; &#39;d&#39;");
    // Plain-text body stays raw (it's not markup).
    expect(mail.text).toContain(`a & b "c" 'd'`);
  });

  it("is deterministic — same input, same rendering (no clock/random reads)", () => {
    const a = notificationEmail(APPROVAL, LINKS);
    const b = notificationEmail(APPROVAL, LINKS);
    expect(a).toEqual(b);
  });

  it("is self-contained HTML — no external images/stylesheets/scripts", () => {
    const mail = notificationEmail(APPROVAL, LINKS);
    expect(mail.html).not.toMatch(/<img|<script|<link|url\(/);
  });
});
