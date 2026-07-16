import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __notifyDeps,
  type NotificationChannelRow,
  sendNotification,
} from "../src/temporal/activities";

const fetch = vi.fn();
// The tenant's ENABLED channels the worker fans out to (readChannels returns only enabled rows).
let channels: NotificationChannelRow[];

// Capture the env we mutate so it can't leak into other test files (Vitest reuses workers).
const savedEnv = {
  APP_BASE_URL: process.env.APP_BASE_URL,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
};
afterEach(() => {
  for (const k of ["APP_BASE_URL", "ENCRYPTION_KEY"] as const) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(() => {
  fetch.mockReset().mockResolvedValue({ ok: true } as never);
  // Deep-link URLs are built from these; without them the links are omitted.
  process.env.APP_BASE_URL = "https://app.naary.test";
  process.env.ENCRYPTION_KEY = "test-encryption-key";
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
});

const BASE = {
  tenantId: "t1",
  workflowId: "wf-1",
  workflowKey: "poller",
} as const;

describe("sendNotification", () => {
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

  it("formats Slack blocks: a header + a fields section with the run as an inline link", async () => {
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

    // The section carries mrkdwn fields, and the Run field is an ACTUAL link
    // (<url|label>) to the run — not a bare id reference.
    const section = body.blocks.find(
      (b: { type: string; fields?: unknown }) =>
        b.type === "section" && b.fields,
    );
    expect(section).toBeTruthy();
    const joined = section.fields
      .map((f: { text: string }) => f.text)
      .join("\n");
    expect(joined).toContain("<https://app.naary.test/app/runs/wf-1|run wf-1>");
    expect(joined).toContain("*Workflow*");
    // The approval title is its own FULL-WIDTH section (a section with `text`, not `fields`) —
    // free text doesn't belong in the cramped 2-column fields grid.
    const titleSection = body.blocks.find(
      (b: { type: string; text?: { text?: string }; fields?: unknown }) =>
        b.type === "section" && b.text && !b.fields,
    );
    expect(titleSection?.text.text).toContain("Ship it?");
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
    const section = body.blocks.find(
      (b: { type: string; fields?: unknown }) =>
        b.type === "section" && b.fields,
    );
    expect(section).toBeTruthy();
    const joined = section.fields
      .map((f: { text: string }) => f.text)
      .join("\n");
    // The raw control chars must not appear inside the link label / fields — they're escaped,
    // so they can't break the <url|label> markup.
    expect(joined).toContain("run wf-&lt;a&amp;b&gt;");
    expect(joined).toContain("orders&lt;x&gt;");
    expect(joined).not.toMatch(/run wf-<a&b>/);
    // The failure reason is its own full-width section — also escaped.
    const reasonSection = body.blocks.find(
      (b: { type: string; text?: { text?: string }; fields?: unknown }) =>
        b.type === "section" && b.text && !b.fields,
    );
    expect(reasonSection?.text.text).toContain("timeout &amp; &lt;reset&gt;");
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

  it("renders the run id (no link) in the fields section when APP_BASE_URL is unset", async () => {
    process.env.APP_BASE_URL = "";
    await sendNotification({
      ...BASE,
      kind: "run_failed",
      detail: "timed_out",
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    const section = body.blocks.find(
      (b: { type: string; fields?: unknown }) =>
        b.type === "section" && b.fields,
    );
    expect(section).toBeTruthy();
    const joined = section.fields
      .map((f: { text: string }) => f.text)
      .join("\n");
    // No URL to link to → the bare id in backticks, and no <…|…> link markup.
    expect(joined).toContain("`wf-1`");
    expect(joined).not.toContain("|run wf-1>");
    // The failure reason is its own full-width section (not a fields entry).
    const reasonSection = body.blocks.find(
      (b: { type: string; text?: { text?: string }; fields?: unknown }) =>
        b.type === "section" && b.text && !b.fields,
    );
    expect(reasonSection?.text.text).toContain("timed_out");
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
