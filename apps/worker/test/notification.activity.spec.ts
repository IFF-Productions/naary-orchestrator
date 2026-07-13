import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __notifyDeps, sendNotification } from "../src/temporal/activities";

const fetch = vi.fn();
let settings: {
  webhookUrl: string | null;
  onApprovalPending: boolean;
  onRunFailed: boolean;
} | null;

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
  settings = {
    webhookUrl: "https://hooks.example.com/x",
    onApprovalPending: true,
    onRunFailed: true,
  };
  __notifyDeps.assertEgressAllowed = vi
    .fn()
    .mockResolvedValue(undefined) as never;
  __notifyDeps.fetch = ((url: string, init?: RequestInit) =>
    fetch(url, init)) as never;
  __notifyDeps.readSettings = (async () => settings) as never;
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

  it("carries MULTIPLE deep-linked entries (Approve/Reject + View run) for an approval", async () => {
    await sendNotification({
      ...BASE,
      kind: "approval_pending",
      title: "Ship?",
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);

    // Structured `actions` = the multiple entries a recipient acts on.
    expect(body.actions.map((a: { label: string }) => a.label)).toEqual([
      "Approve / Reject",
      "View run",
    ]);
    // Deep link to the resource to act on.
    expect(body.runUrl).toBe("https://app.naary.test/app/runs/wf-1");
    expect(body.approvalUrl).toContain(
      "https://app.naary.test/approve/wf-1?token=",
    );
    // Slack Block Kit: a section + an actions block with two url-buttons.
    const actionsBlock = body.blocks.find(
      (b: { type: string }) => b.type === "actions",
    );
    expect(actionsBlock.elements).toHaveLength(2);
    expect(actionsBlock.elements[1].url).toBe(body.runUrl);
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
    expect(header.text.type).toBe("plain_text");
    expect(header.text.text).toContain("Approval needed");

    // The section carries mrkdwn fields, and the Run field is an ACTUAL link
    // (<url|label>) to the run — not a bare id reference.
    const section = body.blocks.find(
      (b: { type: string; fields?: unknown }) =>
        b.type === "section" && b.fields,
    );
    const joined = section.fields
      .map((f: { text: string }) => f.text)
      .join("\n");
    expect(joined).toContain("<https://app.naary.test/app/runs/wf-1|run wf-1>");
    expect(joined).toContain("*Workflow*");
    expect(joined).toContain("Ship it?"); // the approval title, as a field
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
    const joined = section.fields
      .map((f: { text: string }) => f.text)
      .join("\n");
    // No URL to link to → the bare id in backticks, and no <…|…> link markup.
    expect(joined).toContain("`wf-1`");
    expect(joined).not.toContain("|run wf-1>");
    expect(joined).toContain("timed_out"); // the failure reason, as a field
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
    settings = { webhookUrl: null, onApprovalPending: true, onRunFailed: true };
    await sendNotification({ ...BASE, kind: "run_failed" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("respects the per-event toggle (approval off → no POST)", async () => {
    settings = {
      webhookUrl: "https://hooks.example.com/x",
      onApprovalPending: false,
      onRunFailed: true,
    };
    await sendNotification({ ...BASE, kind: "approval_pending" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("NEVER throws — a webhook failure is swallowed (can't affect the run)", async () => {
    fetch.mockRejectedValue(new Error("503"));
    await expect(
      sendNotification({ ...BASE, kind: "run_failed", detail: "failed" }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when there are no settings at all", async () => {
    settings = null;
    await sendNotification({ ...BASE, kind: "run_failed" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
