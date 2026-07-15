import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const findUnique = vi.fn();
const upsert = vi.fn();
const deleteMany = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    notificationChannel: { findMany, findUnique, upsert, deleteMany },
  }),
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
  findMany.mockReset();
  findUnique.mockReset();
  upsert.mockReset();
  deleteMany.mockReset();
  assertEgressAllowed.mockReset().mockResolvedValue(undefined);
  safeFetch.mockReset().mockResolvedValue({ ok: true, status: 200 });
});

describe("NotificationsService.list", () => {
  it("returns EVERY known channel, defaulting unconfigured ones to disabled/no-URL", async () => {
    findMany.mockResolvedValue([]);
    const out = await svc.list("t-1");
    expect(out.map((c) => c.type)).toEqual(["slack", "teams"]);
    // An unsaved channel is disabled (never sends) with events defaulting on.
    for (const c of out) {
      expect(c).toMatchObject({
        enabled: false,
        webhookUrl: null,
        onApprovalPending: true,
        onRunFailed: true,
      });
    }
  });

  it("merges saved rows over defaults, keeping channels independent", async () => {
    findMany.mockResolvedValue([
      {
        type: "slack",
        enabled: true,
        webhookUrl: "https://h/slack",
        onApprovalPending: true,
        onRunFailed: false,
      },
    ]);
    const out = await svc.list("t-1");
    const slack = out.find((c) => c.type === "slack")!;
    const teams = out.find((c) => c.type === "teams")!;
    expect(slack).toMatchObject({
      enabled: true,
      webhookUrl: "https://h/slack",
      onRunFailed: false,
    });
    // Teams unconfigured → still disabled, independent of Slack.
    expect(teams).toMatchObject({ enabled: false, webhookUrl: null });
  });
});

describe("NotificationsService.saveChannel", () => {
  it("upserts ONE channel by (tenant,type) and normalizes a blank URL to null", async () => {
    upsert.mockResolvedValue({
      type: "teams",
      enabled: true,
      webhookUrl: null,
      onApprovalPending: true,
      onRunFailed: true,
    });
    await svc.saveChannel("t-1", "teams", { enabled: true, webhookUrl: "  " });
    expect(upsert.mock.calls[0][0].where).toEqual({
      tenantId_type: { tenantId: "t-1", type: "teams" },
    });
    expect(upsert.mock.calls[0][0].update.webhookUrl).toBeNull();
  });

  it("passes a real URL through and reports the saved view", async () => {
    upsert.mockResolvedValue({
      type: "slack",
      enabled: true,
      webhookUrl: "https://h/x",
      onApprovalPending: true,
      onRunFailed: true,
    });
    const out = await svc.saveChannel("t-1", "slack", {
      webhookUrl: "https://h/x",
    });
    expect(upsert.mock.calls[0][0].update.webhookUrl).toBe("https://h/x");
    expect(out.type).toBe("slack");
  });

  it("rejects an unknown channel type", async () => {
    await expect(
      svc.saveChannel("t-1", "discord", { enabled: true }),
    ).rejects.toThrow(/Unknown notification channel/);
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("NotificationsService.deleteChannel", () => {
  it("deletes the channel's config by (tenant,type)", async () => {
    deleteMany.mockResolvedValue({ count: 1 });
    await svc.deleteChannel("t-1", "teams");
    expect(deleteMany).toHaveBeenCalledWith({
      where: { tenantId: "t-1", type: "teams" },
    });
  });
});

describe("NotificationsService.sendTest", () => {
  it("400s (and never fetches) when the channel has no webhook", async () => {
    findUnique.mockResolvedValue(null);
    await expect(svc.sendTest("t-1", "slack")).rejects.toThrow(
      /No webhook URL/,
    );
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("POSTs Slack blocks for the slack channel and reports ok on 2xx", async () => {
    findUnique.mockResolvedValue({
      type: "slack",
      enabled: true,
      webhookUrl: "https://hooks.slack.com/x",
      onApprovalPending: true,
      onRunFailed: true,
    });
    const out = await svc.sendTest("t-1", "slack");
    expect(out).toEqual({ ok: true, status: 200 });
    expect(assertEgressAllowed).toHaveBeenCalledWith(
      "https://hooks.slack.com/x",
    );
    const body = JSON.parse(safeFetch.mock.calls[0][1].body);
    expect(body.blocks[0].type).toBe("header"); // Slack shape, not the Teams envelope
    expect(body.type).toBeUndefined();
  });

  it("POSTs a Teams Adaptive Card envelope for the teams channel", async () => {
    findUnique.mockResolvedValue({
      type: "teams",
      enabled: true,
      webhookUrl: "https://teams.example/x",
      onApprovalPending: true,
      onRunFailed: true,
    });
    await svc.sendTest("t-1", "teams");
    const body = JSON.parse(safeFetch.mock.calls[0][1].body);
    expect(body.type).toBe("message");
    expect(body.attachments[0].contentType).toBe(
      "application/vnd.microsoft.card.adaptive",
    );
  });

  it("maps a blocked (SSRF) URL to a 400 without fetching", async () => {
    findUnique.mockResolvedValue({
      type: "slack",
      enabled: true,
      webhookUrl: "https://169.254.169.254/x",
      onApprovalPending: true,
      onRunFailed: true,
    });
    assertEgressAllowed.mockRejectedValue(
      new BlockedEgressError("host resolves to a private/reserved address"),
    );
    await expect(svc.sendTest("t-1", "slack")).rejects.toThrow(/isn't allowed/);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("surfaces a non-2xx webhook response as a 400", async () => {
    findUnique.mockResolvedValue({
      type: "teams",
      enabled: true,
      webhookUrl: "https://teams.example/x",
      onApprovalPending: true,
      onRunFailed: true,
    });
    safeFetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(svc.sendTest("t-1", "teams")).rejects.toThrow(/responded 404/);
  });
});
