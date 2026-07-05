import { beforeEach, describe, expect, it, vi } from "vitest";
import { __notifyDeps, sendNotification } from "../src/temporal/activities";

const fetch = vi.fn();
let settings: {
  webhookUrl: string | null;
  onApprovalPending: boolean;
  onRunFailed: boolean;
} | null;

beforeEach(() => {
  fetch.mockReset().mockResolvedValue({ ok: true } as never);
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
