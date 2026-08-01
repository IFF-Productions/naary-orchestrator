import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __notifyDeps,
  type NotificationChannelRow,
  sendNotification,
} from "../src/temporal/activities";

const fetch = vi.fn();
const sendMail = vi.fn();
const resolveSmtpUri = vi.fn();
const pinnedSmtpUri = vi.fn();
// The tenant's ENABLED channels the worker fans out to (readChannels returns only enabled rows).
let channels: NotificationChannelRow[];

// Capture the env we mutate so it can't leak into other test files (Vitest reuses workers).
const savedEnv = {
  APP_BASE_URL: process.env.APP_BASE_URL,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  CORS_ORIGINS: process.env.CORS_ORIGINS,
};
afterEach(() => {
  for (const k of ["APP_BASE_URL", "ENCRYPTION_KEY", "CORS_ORIGINS"] as const) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(() => {
  fetch.mockReset().mockResolvedValue({ ok: true } as never);
  // Deep-link URLs are built from these; without them the links are omitted.
  process.env.APP_BASE_URL = "https://app.naary.test";
  process.env.ENCRYPTION_KEY = "test-encryption-key";
  // Clear the CORS_ORIGINS fallback so the "APP_BASE_URL unset" cases truly resolve to no link.
  process.env.CORS_ORIGINS = "";
  channels = [
    {
      type: "slack",
      webhookUrl: "https://hooks.example.com/x",
      onApprovalPending: true,
      onRunFailed: true,
    },
  ];
  __notifyDeps.assertEgressAllowed = vi
    .fn()
    .mockResolvedValue(undefined) as never;
  __notifyDeps.fetch = ((url: string, init?: RequestInit) =>
    fetch(url, init)) as never;
  __notifyDeps.readChannels = (async () => channels) as never;
  // Email seam (Slice 4): resolver + SSRF check/pin + transport, all test doubles — no SMTP/DB.
  sendMail.mockReset().mockResolvedValue({ messageId: "m1" });
  resolveSmtpUri
    .mockReset()
    .mockResolvedValue("smtps://ops%40acme.io:s3cret@smtp.acme.io:465");
  pinnedSmtpUri
    .mockReset()
    .mockImplementation(
      async (uri: string) => `${uri}?servername=smtp.acme.io`,
    );
  __notifyDeps.resolveSmtpUri = resolveSmtpUri as never;
  __notifyDeps.pinnedSmtpUri = pinnedSmtpUri as never;
  __notifyDeps.createTransport = (() => ({ sendMail })) as never;
});

const BASE = {
  tenantId: "t1",
  workflowId: "wf-1",
  workflowKey: "poller",
} as const;

describe("sendNotification", () => {
  it("reads the RUN'S env's channels; absent env (pre-6b run) is passed through as undefined", async () => {
    // The default-env fallback lives in the real readChannels impl (DB-side), deliberately
    // outside this seam — the activity just forwards what the run recorded.
    const readChannels = vi.fn(async () => channels);
    __notifyDeps.readChannels = readChannels as never;

    await sendNotification({
      ...BASE,
      environmentId: "env-1",
      kind: "approval_pending",
      title: "Ship it?",
    });
    expect(readChannels).toHaveBeenCalledWith("t1", "env-1");

    await sendNotification({ ...BASE, kind: "run_failed", detail: "failed" });
    expect(readChannels).toHaveBeenCalledWith("t1", undefined);
  });

  it("POSTs a Slack-friendly payload when a webhook is set + the event is enabled", async () => {
    await sendNotification({
      ...BASE,
      kind: "approval_pending",
      title: "Ship it?",
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://hooks.example.com/x");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.kind).toBe("approval_pending");
    expect(body.text).toContain("Ship it?"); // the { text } Slack/Teams show
    expect(body.workflowId).toBe("wf-1");
  });

  it("carries separate one-click Approve + Reject entries (+ View run) for an approval", async () => {
    await sendNotification({
      ...BASE,
      kind: "approval_pending",
      title: "Ship?",
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);

    // Structured `actions` = the multiple entries a recipient acts on — now TWO decision
    // buttons (each with the choice pre-selected) plus View run.
    expect(body.actions.map((a: { label: string }) => a.label)).toEqual([
      "✅ Approve",
      "❌ Reject",
      "View run",
    ]);
    // Each decision button deep-links to the signed page with the choice pre-filled.
    const approve = body.actions[0];
    const reject = body.actions[1];
    expect(approve.url).toContain("https://app.naary.test/approve/wf-1?token=");
    expect(approve.url).toContain("&decision=approve");
    expect(reject.url).toContain("&decision=reject");
    expect(body.runUrl).toBe("https://app.naary.test/app/runs/wf-1");
    expect(body.approvalUrl).toContain(
      "https://app.naary.test/approve/wf-1?token=",
    );

    // Slack Block Kit: an actions block with three url-buttons, coloured primary/danger.
    const actionsBlock = body.blocks.find(
      (b: { type: string }) => b.type === "actions",
    );
    expect(actionsBlock.elements).toHaveLength(3);
    expect(actionsBlock.elements[0].style).toBe("primary");
    expect(actionsBlock.elements[1].style).toBe("danger");
    // The plain "View run" button carries no style.
    expect(actionsBlock.elements[2].style).toBeUndefined();
    expect(actionsBlock.elements[2].url).toBe(body.runUrl);
    // Slack requires an action_id on every button (else invalid_blocks).
    expect(
      actionsBlock.elements.every(
        (el: { action_id?: string }) => !!el.action_id,
      ),
    ).toBe(true);
  });

  it("formats Slack blocks: header + prose headline + a grey context line, no fields grid", async () => {
    await sendNotification({
      ...BASE,
      kind: "approval_pending",
      title: "Ship it?",
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);

    // A header block leads the message (rich formatting, not one flat line).
    const header = body.blocks.find(
      (b: { type: string }) => b.type === "header",
    );
    expect(header).toBeTruthy();
    expect(header.text.type).toBe("plain_text");
    expect(header.text.text).toContain("Approval needed");

    // The body is one prose section — what is waiting, said as a sentence. NO `fields`
    // array anywhere: Slack renders that as the two-column form this replaced (#987).
    const section = body.blocks.find(
      (b: { type: string; text?: unknown }) => b.type === "section" && b.text,
    );
    expect(section.text.text).toBe("*poller* — Ship it?");
    expect(
      body.blocks.some((b: { fields?: unknown }) => b.fields !== undefined),
    ).toBe(false);

    // The run id lives in the small grey context line, never as a link label.
    const context = body.blocks.find(
      (b: { type: string }) => b.type === "context",
    );
    expect(context.elements[0].text).toBe("Run `wf-1`");
    expect(JSON.stringify(body.blocks)).not.toContain("|run wf-1>");
  });

  it("escapes Slack mrkdwn control chars (& < >) in interpolated ids/labels", async () => {
    await sendNotification({
      tenantId: "t1",
      workflowId: "wf-<a&b>",
      workflowKey: "orders<x>",
      kind: "run_failed",
      detail: "timeout & <reset>",
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    // Headline (workflow + reason) and context (run id) are both mrkdwn — the raw control
    // chars must not survive in either, so they can't break markup or inject a link.
    const section = body.blocks.find(
      (b: { type: string; text?: unknown }) => b.type === "section" && b.text,
    );
    expect(section.text.text).toContain("orders&lt;x&gt;");
    expect(section.text.text).toContain("timeout &amp; &lt;reset&gt;");
    expect(section.text.text).not.toMatch(/orders<x>/);
    const context = body.blocks.find(
      (b: { type: string }) => b.type === "context",
    );
    expect(context.elements[0].text).toContain("wf-&lt;a&amp;b&gt;");
    expect(context.elements[0].text).not.toMatch(/wf-<a&b>/);
    // The top-level `text` fallback (Slack renders it as mrkdwn too) is ALSO escaped, so control
    // chars can't break/inject in clients that show the fallback line.
    expect(body.text).toContain("orders&lt;x&gt;");
    expect(body.text).toContain("wf-&lt;a&amp;b&gt;");
    expect(body.text).not.toMatch(/orders<x>/);
  });

  it("neutralizes backticks so a value can't break a Slack inline-code span", async () => {
    await sendNotification({
      ...BASE,
      workflowKey: "orders`rm -rf`",
      kind: "run_failed",
      detail: "boom`code`",
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    const codeSpans = body.blocks
      .flatMap(
        (b: { fields?: { text: string }[]; text?: { text: string } }) => [
          ...(b.fields?.map((f) => f.text) ?? []),
          b.text?.text ?? "",
        ],
      )
      .join("\n");
    // No raw backtick survives inside the rendered code spans (workflowKey + Reason).
    expect(codeSpans).not.toContain("`rm -rf`");
    expect(codeSpans).not.toContain("boom`code`");
    expect(codeSpans).toContain("ordersʼrm -rf");
    expect(codeSpans).toContain("boomʼcode");
  });

  it("still names the run (context line) and the reason when APP_BASE_URL is unset", async () => {
    process.env.APP_BASE_URL = "";
    await sendNotification({
      ...BASE,
      kind: "run_failed",
      detail: "timed_out",
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    const context = body.blocks.find(
      (b: { type: string }) => b.type === "context",
    );
    // No URL to link to → the id still reads in the context line, and no <…|…> markup.
    expect(context.elements[0].text).toBe("Run `wf-1`");
    expect(JSON.stringify(body.blocks)).not.toContain("|run wf-1>");
    // The reason rides the headline (short + no error type → inline).
    const section = body.blocks.find(
      (b: { type: string; text?: unknown }) => b.type === "section" && b.text,
    );
    expect(section.text.text).toBe("*poller* — timed_out");
  });

  it("includes a View-run deep link on a failed-run notification (the prior gap)", async () => {
    await sendNotification({
      ...BASE,
      kind: "run_failed",
      detail: "timed_out",
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);

    expect(body.runUrl).toBe("https://app.naary.test/app/runs/wf-1");
    expect(body.text).toContain("https://app.naary.test/app/runs/wf-1");
    expect(body.actions).toEqual([
      { label: "View run", url: "https://app.naary.test/app/runs/wf-1" },
    ]);
    // No approval action on a failure.
    expect(body.approvalUrl).toBeUndefined();
  });

  it("omits deep links (no blocks actions) when APP_BASE_URL is unset", async () => {
    process.env.APP_BASE_URL = "";
    await sendNotification({ ...BASE, kind: "run_failed" });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    expect(body.runUrl).toBeUndefined();
    expect(body.actions).toEqual([]);
    // Only the section block remains — no actions row.
    expect(
      body.blocks.some((b: { type: string }) => b.type === "actions"),
    ).toBe(false);
  });

  it("omits the approve link (not a relative URL) for an approval when APP_BASE_URL is unset", async () => {
    process.env.APP_BASE_URL = "";
    await sendNotification({
      ...BASE,
      kind: "approval_pending",
      title: "Ship?",
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    // Regression: approvalUrl must not fall back to a relative `/approve/…` (a broken Slack button).
    expect(body.approvalUrl).toBeUndefined();
    expect(body.actions).toEqual([]);
  });

  it("falls back to the CORS_ORIGINS SPA origin when APP_BASE_URL is unset", async () => {
    process.env.APP_BASE_URL = "";
    // Prod sets CORS_ORIGINS for the browser to reach the API; reuse its first https origin so
    // alerts still get clickable links + Approve/Reject buttons without a separate var.
    process.env.CORS_ORIGINS = "https://app.acme.io, https://staging.acme.io";
    await sendNotification({
      ...BASE,
      kind: "approval_pending",
      title: "Ship?",
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    expect(body.runUrl).toBe("https://app.acme.io/app/runs/wf-1");
    expect(body.approvalUrl).toContain(
      "https://app.acme.io/approve/wf-1?token=",
    );
    expect(body.actions.map((a: { label: string }) => a.label)).toEqual([
      "✅ Approve",
      "❌ Reject",
      "View run",
    ]);
  });

  it("normalizes a base with a stray query/fragment to origin+path (no broken concat)", async () => {
    process.env.APP_BASE_URL = "https://app.acme.io/console?tab=x#frag";
    await sendNotification({ ...BASE, kind: "run_failed", detail: "boom" });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    // Query/fragment dropped, path kept — so the deep link is well-formed, not
    // "…/console?tab=x#frag/app/runs/wf-1".
    expect(body.runUrl).toBe("https://app.acme.io/console/app/runs/wf-1");
  });

  it("ignores a non-URL APP_BASE_URL (no scheme) → no link", async () => {
    process.env.APP_BASE_URL = "app.acme.io"; // not an absolute http(s) URL
    process.env.CORS_ORIGINS = "";
    await sendNotification({ ...BASE, kind: "run_failed" });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    expect(body.runUrl).toBeUndefined();
  });

  it("is a NO-OP when no webhook URL is configured", async () => {
    channels = [
      {
        type: "slack",
        webhookUrl: null,
        onApprovalPending: true,
        onRunFailed: true,
      },
    ];
    await sendNotification({ ...BASE, kind: "run_failed" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("respects the per-event toggle (approval off → no POST)", async () => {
    channels = [
      {
        type: "slack",
        webhookUrl: "https://hooks.example.com/x",
        onApprovalPending: false,
        onRunFailed: true,
      },
    ];
    await sendNotification({ ...BASE, kind: "approval_pending" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("NEVER throws — a webhook failure is swallowed (can't affect the run)", async () => {
    fetch.mockRejectedValue(new Error("503"));
    await expect(
      sendNotification({ ...BASE, kind: "run_failed", detail: "failed" }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when there are no enabled channels at all", async () => {
    channels = [];
    await sendNotification({ ...BASE, kind: "run_failed" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("FANS OUT to every enabled channel (Slack + Teams both get POSTed)", async () => {
    channels = [
      {
        type: "slack",
        webhookUrl: "https://hooks.slack.com/x",
        onApprovalPending: true,
        onRunFailed: true,
      },
      {
        type: "teams",
        webhookUrl: "https://teams.example/x",
        onApprovalPending: true,
        onRunFailed: true,
      },
    ];
    await sendNotification({ ...BASE, kind: "run_failed", detail: "boom" });
    expect(fetch).toHaveBeenCalledTimes(2);
    const urls = fetch.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([
      "https://hooks.slack.com/x",
      "https://teams.example/x",
    ]);
    // Each got its OWN format: Slack blocks vs the Teams envelope.
    const slackBody = JSON.parse(fetch.mock.calls[0][1].body as string);
    const teamsBody = JSON.parse(fetch.mock.calls[1][1].body as string);
    expect(Array.isArray(slackBody.blocks)).toBe(true);
    expect(teamsBody.type).toBe("message");
  });

  it("fans out to SEVERAL channels of the SAME type (two Slack webhooks → two POSTs)", async () => {
    channels = [
      {
        type: "slack",
        webhookUrl: "https://hooks.slack.com/alerts",
        onApprovalPending: true,
        onRunFailed: true,
      },
      {
        type: "slack",
        webhookUrl: "https://hooks.slack.com/oncall",
        onApprovalPending: true,
        onRunFailed: true,
      },
    ];
    await sendNotification({ ...BASE, kind: "run_failed", detail: "boom" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      "https://hooks.slack.com/alerts",
      "https://hooks.slack.com/oncall",
    ]);
    // Same type → same (Slack) format to both.
    for (const call of fetch.mock.calls) {
      const body = JSON.parse(call[1].body as string);
      expect(Array.isArray(body.blocks)).toBe(true);
    }
  });

  it("routes per-channel: a failure goes to the channel with onRunFailed, not the other", async () => {
    channels = [
      {
        type: "slack",
        webhookUrl: "https://hooks.slack.com/x",
        onApprovalPending: true,
        onRunFailed: false, // Slack: approvals only
      },
      {
        type: "teams",
        webhookUrl: "https://teams.example/x",
        onApprovalPending: false,
        onRunFailed: true, // Teams: failures only
      },
    ];
    await sendNotification({ ...BASE, kind: "run_failed", detail: "boom" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe("https://teams.example/x");
  });

  it("ISOLATES channels: one bad webhook does not stop the next channel's POST", async () => {
    channels = [
      {
        type: "slack",
        webhookUrl: "https://hooks.slack.com/x",
        onApprovalPending: true,
        onRunFailed: true,
      },
      {
        type: "teams",
        webhookUrl: "https://teams.example/x",
        onApprovalPending: true,
        onRunFailed: true,
      },
    ];
    // First POST (Slack) throws; Teams must still be attempted.
    fetch
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce({ ok: true });
    await sendNotification({ ...BASE, kind: "run_failed", detail: "boom" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe("https://teams.example/x");
  });
});

describe("sendNotification — budget_threshold (Slice 3)", () => {
  const BUDGET = {
    tenantId: "t1",
    workflowId: "wf-1",
    kind: "budget_threshold" as const,
    thresholdPct: 80,
    capUsd: 400,
    spendUsd: 321.4,
  };

  it("is OPT-IN: a channel without onBudgetThreshold (default/legacy) gets NO post", async () => {
    // The default channel above has no onBudgetThreshold field at all (legacy row shape).
    await sendNotification(BUDGET);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("POSTs to a channel that opted in, with the usage deep link + budget facts", async () => {
    channels = [
      {
        type: "slack",
        webhookUrl: "https://hooks.example.com/x",
        onApprovalPending: false,
        onRunFailed: false,
        onBudgetThreshold: true,
      },
    ];
    await sendNotification(BUDGET);
    expect(fetch).toHaveBeenCalledOnce();
    const body = JSON.parse(
      (fetch.mock.calls[0][1] as { body: string }).body,
    ) as {
      text: string;
      kind: string;
      usageUrl?: string;
      thresholdPct?: number;
    };
    expect(body.kind).toBe("budget_threshold");
    expect(body.thresholdPct).toBe(80);
    expect(body.text).toContain("80%");
    expect(body.usageUrl).toBe("https://app.naary.test/app/billing");
  });

  it("routes per-channel: only the opted-in channel is posted", async () => {
    channels = [
      {
        type: "slack",
        webhookUrl: "https://hooks.example.com/alerts",
        onApprovalPending: true,
        onRunFailed: true,
        onBudgetThreshold: false,
      },
      {
        type: "teams",
        webhookUrl: "https://hooks.example.com/finance",
        onApprovalPending: false,
        onRunFailed: false,
        onBudgetThreshold: true,
      },
    ];
    await sendNotification(BUDGET);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe("https://hooks.example.com/finance");
    // Teams channel → Adaptive Card envelope with the budget FactSet.
    const body = JSON.parse(
      (fetch.mock.calls[0][1] as { body: string }).body,
    ) as { type: string; attachments: { content: { body: unknown[] } }[] };
    expect(body.type).toBe("message");
    expect(JSON.stringify(body)).toContain("Monthly cap");
  });

  it("omits the usage link when no base URL resolves (no fabricated buttons)", async () => {
    delete process.env.APP_BASE_URL;
    process.env.CORS_ORIGINS = "";
    channels = [
      {
        type: "slack",
        webhookUrl: "https://hooks.example.com/x",
        onApprovalPending: false,
        onRunFailed: false,
        onBudgetThreshold: true,
      },
    ];
    await sendNotification(BUDGET);
    const body = JSON.parse(
      (fetch.mock.calls[0][1] as { body: string }).body,
    ) as { usageUrl?: string; actions: unknown[] };
    expect(body.usageUrl).toBeUndefined();
    expect(body.actions).toEqual([]);
  });
});

describe("sendNotification — approval reminder/escalation flavors (Slice 1)", () => {
  it("reminder flavor: header + text say reminder #N; decision buttons stay", async () => {
    await sendNotification({
      ...BASE,
      kind: "approval_pending",
      flavor: "reminder",
      reminderIndex: 2,
      title: "Ship it?",
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    const header = body.blocks.find(
      (b: { type: string }) => b.type === "header",
    );
    expect(header.text.text).toBe("⏰ Approval reminder #2");
    expect(body.text).toContain("Reminder #2");
    expect(body.text).toContain("Ship it?");
    // Same one-click decision actions as the initial pause notification.
    expect(body.actions.map((a: { label: string }) => a.label)).toEqual([
      "✅ Approve",
      "❌ Reject",
      "View run",
    ]);
    // Generic hooks can branch on the flavor.
    expect(body.flavor).toBe("reminder");
    expect(body.reminderIndex).toBe(2);
  });

  it("reminder without an index (manual Remind now) drops the #N", async () => {
    await sendNotification({
      ...BASE,
      kind: "approval_pending",
      flavor: "reminder",
      title: "Ship it?",
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    const header = body.blocks.find(
      (b: { type: string }) => b.type === "header",
    );
    expect(header.text.text).toBe("⏰ Approval reminder");
  });

  it("escalation flavor: names the target in a full-width section (escaped)", async () => {
    await sendNotification({
      ...BASE,
      kind: "approval_pending",
      flavor: "escalation",
      escalateTo: "@ops-oncall <primary>",
      title: "Ship it?",
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    const header = body.blocks.find(
      (b: { type: string }) => b.type === "header",
    );
    expect(header.text.text).toBe("🚨 Approval escalated");
    // The target is named on its own line of the headline — it is WHO must act, not a
    // label/value pair in a grid.
    const target = body.blocks.find(
      (b: { type: string; text?: { text?: string } }) =>
        b.type === "section" && b.text?.text?.includes("Escalated to"),
    );
    expect(target?.text.text).toContain("*@ops-oncall &lt;primary&gt;*");
    expect(body.text).toContain("escalated to @ops-oncall &lt;primary&gt;");
    expect(body.escalateTo).toBe("@ops-oncall <primary>");
  });

  it("flavors still respect the onApprovalPending channel toggle", async () => {
    channels = [
      {
        type: "slack",
        webhookUrl: "https://hooks.example.com/x",
        onApprovalPending: false,
        onRunFailed: true,
      },
    ];
    await sendNotification({
      ...BASE,
      kind: "approval_pending",
      flavor: "reminder",
      reminderIndex: 1,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Teams: reminder/escalation ride the FactSet (plain values, no mrkdwn)", async () => {
    channels = [
      {
        type: "teams",
        webhookUrl: "https://teams.example/x",
        onApprovalPending: true,
        onRunFailed: true,
      },
    ];
    await sendNotification({
      ...BASE,
      kind: "approval_pending",
      flavor: "escalation",
      escalateTo: "@ops-oncall",
      title: "Ship?",
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    const card = body.attachments[0].content;
    const headerBlock = card.body.find(
      (b: { type: string }) => b.type === "TextBlock",
    );
    expect(headerBlock.text).toBe("🚨 Approval escalated");
    const facts = card.body.find((b: { type: string }) => b.type === "FactSet")
      .facts as { title: string; value: string }[];
    expect(facts).toContainEqual({
      title: "Escalated to",
      value: "@ops-oncall",
    });
  });

  it("approval links now carry a SIGNED expiry claim (&exp=…)", async () => {
    await sendNotification({
      ...BASE,
      kind: "approval_pending",
      title: "Ship?",
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    expect(body.approvalUrl).toMatch(/\?token=[0-9a-f]{64}&exp=\d+$/);
    const exp = Number(
      new URL(body.approvalUrl).searchParams.get("exp") ?? "0",
    );
    // Fresh mint → the claim is in the future.
    expect(exp).toBeGreaterThan(Date.now() / 1000);
  });
});

describe("sendNotification — Microsoft Teams channel", () => {
  /** The Adaptive Card content object out of the Teams envelope. */
  function teamsCard(body: {
    type: string;
    attachments: {
      contentType: string;
      content: {
        type: string;
        version: string;
        body: { type: string; text?: string; facts?: unknown }[];
        actions?: {
          type: string;
          title: string;
          url: string;
          style?: string;
        }[];
      };
    }[];
  }) {
    return body.attachments[0].content;
  }

  it("sends the Adaptive Card envelope (not Slack blocks) when channel is teams", async () => {
    channels = [
      {
        type: "teams",
        webhookUrl: "https://prod-1.westus.logic.azure.com/workflows/x",
        onApprovalPending: true,
        onRunFailed: true,
      },
    ];
    await sendNotification({
      ...BASE,
      kind: "approval_pending",
      title: "Ship?",
    });

    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    // The Teams message envelope — NOT the Slack { text, blocks } shape.
    expect(body.type).toBe("message");
    expect(body.blocks).toBeUndefined();
    expect(body.attachments[0].contentType).toBe(
      "application/vnd.microsoft.card.adaptive",
    );
    const card = teamsCard(body);
    expect(card.type).toBe("AdaptiveCard");
    expect(card.version).toBe("1.2");
  });

  it("carries the header, a FactSet, and Approve/Reject/View-run OpenUrl actions", async () => {
    channels = [
      {
        type: "teams",
        webhookUrl: "https://teams.example/x",
        onApprovalPending: true,
        onRunFailed: true,
      },
    ];
    await sendNotification({
      ...BASE,
      kind: "approval_pending",
      title: "Ship?",
    });
    const card = teamsCard(JSON.parse(fetch.mock.calls[0][1].body as string));

    const header = card.body.find((b) => b.type === "TextBlock");
    expect(header?.text).toContain("Approval needed");
    const factSet = card.body.find((b) => b.type === "FactSet") as {
      facts: { title: string; value: string }[];
    };
    // Run id is a PLAIN fact value — not a mrkdwn link, not escaped.
    const runFact = factSet.facts.find((f) => f.title === "Run");
    expect(runFact?.value).toBe("wf-1");

    // Approve/Reject deep-link (decision pre-filled) + View run, all Action.OpenUrl.
    expect(card.actions?.map((a) => a.type)).toEqual([
      "Action.OpenUrl",
      "Action.OpenUrl",
      "Action.OpenUrl",
    ]);
    expect(card.actions?.[0].title).toBe("✅ Approve");
    expect(card.actions?.[0].url).toContain("&decision=approve");
    expect(card.actions?.[0].style).toBe("positive");
    expect(card.actions?.[1].style).toBe("destructive");
    expect(card.actions?.[2].title).toBe("View run");
    expect(card.actions?.[2].style).toBeUndefined();
  });

  it("does NOT Slack-escape Teams fact values (plain JSON, no &amp; double-encoding)", async () => {
    channels = [
      {
        type: "teams",
        webhookUrl: "https://teams.example/x",
        onApprovalPending: true,
        onRunFailed: true,
      },
    ];
    await sendNotification({
      tenantId: "t1",
      workflowId: "wf-1",
      workflowKey: "orders & returns",
      kind: "run_failed",
      detail: "timeout <reset>",
    });
    const card = teamsCard(JSON.parse(fetch.mock.calls[0][1].body as string));
    const facts = (
      card.body.find((b) => b.type === "FactSet") as {
        facts: { title: string; value: string }[];
      }
    ).facts;
    // Plain strings — the raw chars, NOT &amp;/&lt; (Adaptive Card isn't mrkdwn).
    expect(facts.find((f) => f.title === "Workflow")?.value).toBe(
      "orders & returns",
    );
    expect(facts.find((f) => f.title === "Reason")?.value).toBe(
      "timeout <reset>",
    );
  });

  it("uses the Slack shape for an unknown/legacy channel type (fallback)", async () => {
    channels = [
      {
        type: "discord", // unknown type → Slack/generic payload, not the Teams envelope
        webhookUrl: "https://hooks.slack.com/x",
        onApprovalPending: true,
        onRunFailed: true,
      },
    ];
    await sendNotification({ ...BASE, kind: "run_failed", detail: "boom" });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    expect(body.type).toBeUndefined(); // not the Teams envelope
    expect(Array.isArray(body.blocks)).toBe(true);
  });
});

describe("sendNotification — email channel (Slice 4)", () => {
  const EMAIL_CHANNEL: NotificationChannelRow = {
    type: "email",
    webhookUrl: null,
    config: { connectionId: "conn-smtp-1", to: ["ops@acme.io", "sre@acme.io"] },
    onApprovalPending: true,
    onRunFailed: true,
  };

  it("delivers an approval email via the SMTP connection — same signed links as Slack", async () => {
    channels = [EMAIL_CHANNEL];
    await sendNotification({
      ...BASE,
      kind: "approval_pending",
      title: "Ship it?",
    });

    // No webhook POST for an email channel.
    expect(fetch).not.toHaveBeenCalled();
    // The SMTP URI is resolved by tenant + the channel's connectionId, at send time.
    expect(resolveSmtpUri).toHaveBeenCalledWith("t1", "conn-smtp-1");
    // SSRF: the URI is validated + connect-pinned, and the pinned URI is what we dial.
    expect(pinnedSmtpUri).toHaveBeenCalledWith(
      "smtps://ops%40acme.io:s3cret@smtp.acme.io:465",
    );
    expect(sendMail).toHaveBeenCalledOnce();
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toEqual(["ops@acme.io", "sre@acme.io"]);
    // `from` defaults to the URI's user (decoded), like the sendEmail node.
    expect(mail.from).toBe("ops@acme.io");
    expect(mail.subject).toContain("Approval needed");
    // Decide-in-place = the SAME signed approve/reject links the Slack buttons carry.
    expect(mail.text).toContain("https://app.naary.test/approve/wf-1?token=");
    expect(mail.text).toContain("&decision=approve");
    expect(mail.text).toContain("&decision=reject");
    expect(mail.html).toContain("&amp;decision=approve");
  });

  it("skips an UNCONFIGURED email channel (no connection / no recipients)", async () => {
    channels = [
      { ...EMAIL_CHANNEL, config: null },
      { ...EMAIL_CHANNEL, config: { connectionId: "conn-1", to: [] } },
      { ...EMAIL_CHANNEL, config: { to: ["ops@acme.io"] } },
    ];
    await sendNotification({ ...BASE, kind: "run_failed", detail: "boom" });
    expect(sendMail).not.toHaveBeenCalled();
    expect(resolveSmtpUri).not.toHaveBeenCalled();
  });

  it("respects the per-event toggles on email channels too", async () => {
    channels = [{ ...EMAIL_CHANNEL, onRunFailed: false }];
    await sendNotification({ ...BASE, kind: "run_failed", detail: "boom" });
    expect(sendMail).not.toHaveBeenCalled();

    channels = [{ ...EMAIL_CHANNEL, onBudgetThreshold: true }];
    await sendNotification({
      tenantId: "t1",
      workflowId: "wf-1",
      kind: "budget_threshold",
      thresholdPct: 80,
      capUsd: 400,
      spendUsd: 321.4,
    });
    expect(sendMail).toHaveBeenCalledOnce();
    expect(sendMail.mock.calls[0][0].subject).toContain("Budget alert");
  });

  it("NEVER throws on an SMTP failure, and the next channel still sends", async () => {
    channels = [
      EMAIL_CHANNEL,
      {
        type: "slack",
        webhookUrl: "https://hooks.slack.com/x",
        onApprovalPending: true,
        onRunFailed: true,
      },
    ];
    sendMail.mockRejectedValue(
      new Error("smtps://user:pass@smtp.acme.io refused"),
    );
    await expect(
      sendNotification({ ...BASE, kind: "run_failed", detail: "boom" }),
    ).resolves.toBeUndefined();
    // The Slack channel was still POSTed after the email failure.
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("a blocked (private) SMTP host is refused before any send", async () => {
    channels = [EMAIL_CHANNEL];
    pinnedSmtpUri.mockRejectedValue(new Error("private host"));
    await sendNotification({ ...BASE, kind: "run_failed", detail: "boom" });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("mixed fan-out: Slack webhook + email both deliver, each in its own format", async () => {
    channels = [
      {
        type: "slack",
        webhookUrl: "https://hooks.slack.com/x",
        onApprovalPending: true,
        onRunFailed: true,
      },
      EMAIL_CHANNEL,
    ];
    await sendNotification({ ...BASE, kind: "run_failed", detail: "boom" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(sendMail).toHaveBeenCalledOnce();
    const mail = sendMail.mock.calls[0][0];
    expect(mail.subject).toBe('❌ Run failed — "poller"');
    expect(mail.html).toContain("boom");
  });
});

describe("sendNotification — legacy fallback (unknown type)", () => {
  it("keeps the Slack shape for an unknown type even with email channels shipped", async () => {
    channels = [
      {
        type: "discord", // unknown type → Slack/generic payload, not the Teams envelope
        webhookUrl: "https://hooks.slack.com/x",
        onApprovalPending: true,
        onRunFailed: true,
      },
    ];
    await sendNotification({ ...BASE, kind: "run_failed", detail: "boom" });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    expect(body.type).toBeUndefined(); // not the Teams envelope
    expect(Array.isArray(body.blocks)).toBe(true);
  });
});
