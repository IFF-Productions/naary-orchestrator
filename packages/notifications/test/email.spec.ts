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

describe("notificationEmail — approval_pending", () => {
  it("subject names the event + workflow; bodies carry the facts", () => {
    const mail = notificationEmail(APPROVAL, LINKS);
    expect(mail.subject).toBe('⏳ Approval needed — "poller"');
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
    expect(mail.subject).toBe('⏰ Approval reminder #2 — "poller"');
    expect(mail.text).toContain("Reminder: #2");
    expect(mail.text).toContain("&decision=approve");
    expect(mail.text).toContain("&decision=reject");
  });

  it("escalation flavor: subject says escalated; target is a fact", () => {
    const mail = notificationEmail(
      { ...APPROVAL, flavor: "escalation", escalateTo: "@ops-oncall" },
      LINKS,
    );
    expect(mail.subject).toBe('🚨 Approval escalated — "poller"');
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
    expect(mail.subject).toBe('❌ Run failed — "poller"');
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
