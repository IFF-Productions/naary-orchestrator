import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const upsert = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ notificationSettings: { findUnique, upsert } }),
}));

// Mock the shared egress guard + transport so sendTest needs no real network. Defined via
// vi.hoisted so the (hoisted) vi.mock factory and the tests share the same class/spies.
const { assertEgressAllowed, safeFetch, BlockedEgressError } = vi.hoisted(
  () => {
    class BlockedEgressError extends Error {}
    return {
      assertEgressAllowed: vi.fn(),
      safeFetch: vi.fn(),
      BlockedEgressError,
    };
  },
);
vi.mock("@naary/connections", () => ({
  assertEgressAllowed,
  safeFetch,
  BlockedEgressError,
}));

import { NotificationsService } from "../src/notifications/notifications.service";

const svc = new NotificationsService();

beforeEach(() => {
  findUnique.mockReset();
  upsert.mockReset();
  assertEgressAllowed.mockReset().mockResolvedValue(undefined);
  safeFetch.mockReset().mockResolvedValue({ ok: true, status: 200 });
});

describe("NotificationsService", () => {
  it("returns safe defaults (no webhook, slack, both events on) when unset", async () => {
    findUnique.mockResolvedValue(null);
    expect(await svc.get("t-1")).toEqual({
      webhookUrl: null,
      channel: "slack",
      onApprovalPending: true,
      onRunFailed: true,
    });
  });

  it("returns the stored settings, including the teams channel", async () => {
    findUnique.mockResolvedValue({
      webhookUrl: "https://h/x",
      channel: "teams",
      onApprovalPending: false,
      onRunFailed: true,
    });
    expect(await svc.get("t-1")).toEqual({
      webhookUrl: "https://h/x",
      channel: "teams",
      onApprovalPending: false,
      onRunFailed: true,
    });
  });

  it("normalizes an unknown/legacy channel value to slack", async () => {
    findUnique.mockResolvedValue({
      webhookUrl: "https://h/x",
      channel: "discord",
      onApprovalPending: true,
      onRunFailed: true,
    });
    expect((await svc.get("t-1")).channel).toBe("slack");
  });

  it("persists the chosen channel on save", async () => {
    upsert.mockResolvedValue({
      webhookUrl: "https://h/x",
      channel: "teams",
      onApprovalPending: true,
      onRunFailed: true,
    });
    const out = await svc.save("t-1", {
      webhookUrl: "https://h/x",
      channel: "teams",
    });
    expect(upsert.mock.calls[0][0].update.channel).toBe("teams");
    expect(upsert.mock.calls[0][0].create.channel).toBe("teams");
    expect(out.channel).toBe("teams");
  });

  it("upserts and NORMALIZES a blank webhook URL to null (turns it off)", async () => {
    upsert.mockResolvedValue({
      webhookUrl: null,
      onApprovalPending: true,
      onRunFailed: true,
    });
    await svc.save("t-1", { webhookUrl: "   ", onRunFailed: true });
    // the update path received null, not the blank string
    expect(upsert.mock.calls[0][0].update.webhookUrl).toBeNull();
  });

  it("passes a real URL through on save", async () => {
    upsert.mockResolvedValue({
      webhookUrl: "https://h/x",
      onApprovalPending: true,
      onRunFailed: true,
    });
    await svc.save("t-1", { webhookUrl: "https://h/x" });
    expect(upsert.mock.calls[0][0].update.webhookUrl).toBe("https://h/x");
  });
});

describe("NotificationsService.sendTest", () => {
  it("400s (and never fetches) when no webhook is configured", async () => {
    findUnique.mockResolvedValue(null);
    await expect(svc.sendTest("t-1")).rejects.toThrow(/No webhook URL/);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("POSTs Slack blocks (default channel) and reports ok on 2xx", async () => {
    findUnique.mockResolvedValue({
      webhookUrl: "https://hooks.slack.com/x",
      channel: "slack",
      onApprovalPending: true,
      onRunFailed: true,
    });
    const out = await svc.sendTest("t-1");
    expect(out).toEqual({ ok: true, status: 200 });
    expect(assertEgressAllowed).toHaveBeenCalledWith(
      "https://hooks.slack.com/x",
    );
    const body = JSON.parse(safeFetch.mock.calls[0][1].body);
    expect(body.blocks[0].type).toBe("header"); // Slack shape, not the Teams envelope
    expect(body.type).toBeUndefined();
  });

  it("POSTs a Teams Adaptive Card envelope when channel is teams", async () => {
    findUnique.mockResolvedValue({
      webhookUrl: "https://teams.example/x",
      channel: "teams",
      onApprovalPending: true,
      onRunFailed: true,
    });
    await svc.sendTest("t-1");
    const body = JSON.parse(safeFetch.mock.calls[0][1].body);
    expect(body.type).toBe("message");
    expect(body.attachments[0].contentType).toBe(
      "application/vnd.microsoft.card.adaptive",
    );
  });

  it("maps a blocked (SSRF) URL to a 400 without fetching", async () => {
    findUnique.mockResolvedValue({
      webhookUrl: "https://169.254.169.254/x",
      channel: "slack",
      onApprovalPending: true,
      onRunFailed: true,
    });
    assertEgressAllowed.mockRejectedValue(
      new BlockedEgressError("host resolves to a private/reserved address"),
    );
    await expect(svc.sendTest("t-1")).rejects.toThrow(/isn't allowed/);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("surfaces a non-2xx webhook response as a 400", async () => {
    findUnique.mockResolvedValue({
      webhookUrl: "https://teams.example/x",
      channel: "teams",
      onApprovalPending: true,
      onRunFailed: true,
    });
    safeFetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(svc.sendTest("t-1")).rejects.toThrow(/responded 404/);
  });
});
