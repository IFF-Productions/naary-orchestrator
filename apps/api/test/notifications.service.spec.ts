import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const findFirst = vi.fn();
const count = vi.fn();
const create = vi.fn();
const update = vi.fn();
const deleteMany = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    notificationChannel: {
      findMany,
      findFirst,
      count,
      create,
      update,
      deleteMany,
    },
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

import {
  MAX_CHANNELS_PER_ENV,
  NotificationsService,
} from "../src/notifications/notifications.service";

const svc = new NotificationsService();

const row = (over: Record<string, unknown> = {}) => ({
  id: "ch_1",
  type: "slack",
  label: null,
  enabled: true,
  webhookUrl: "https://hooks.slack.com/x",
  onApprovalPending: true,
  onRunFailed: true,
  ...over,
});

beforeEach(() => {
  findMany.mockReset();
  findFirst.mockReset();
  count.mockReset().mockResolvedValue(0);
  create.mockReset();
  update.mockReset();
  deleteMany.mockReset();
  assertEgressAllowed.mockReset().mockResolvedValue(undefined);
  safeFetch.mockReset().mockResolvedValue({ ok: true, status: 200 });
});

describe("NotificationsService.list", () => {
  it("returns ALL rows — several channels of the SAME type coexist", async () => {
    findMany.mockResolvedValue([
      row({ id: "ch_1", label: "#alerts" }),
      row({ id: "ch_2", label: "#oncall", webhookUrl: "https://h/2" }),
      row({ id: "ch_3", type: "teams", label: null }),
    ]);
    const out = await svc.list("t-1", "e-1");
    expect(out.map((c) => c.id)).toEqual(["ch_1", "ch_2", "ch_3"]);
    expect(out.filter((c) => c.type === "slack")).toHaveLength(2);
    // Env-scoped (6b): only the active env's channels are listed.
    expect(findMany.mock.calls[0][0].where).toEqual({
      tenantId: "t-1",
      environmentId: "e-1",
    });
    // Stable order comes from the query, not post-sorting.
    expect(findMany.mock.calls[0][0].orderBy).toEqual([
      { type: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ]);
  });

  it("returns an empty list when nothing is configured (no synthesized defaults)", async () => {
    findMany.mockResolvedValue([]);
    expect(await svc.list("t-1", "e-1")).toEqual([]);
  });
});

describe("NotificationsService.createChannel", () => {
  it("creates a SECOND channel of an existing type (N per type)", async () => {
    count.mockResolvedValue(1); // one slack channel already exists
    create.mockResolvedValue(row({ id: "ch_2", label: "#oncall" }));
    const out = await svc.createChannel("t-1", "e-1", "slack", {
      label: "#oncall",
      webhookUrl: "https://hooks.slack.com/second",
    });
    expect(out.id).toBe("ch_2");
    expect(create.mock.calls[0][0].data).toMatchObject({
      tenantId: "t-1",
      environmentId: "e-1",
      type: "slack",
      label: "#oncall",
      enabled: true, // explicit add → on by default
      webhookUrl: "https://hooks.slack.com/second",
    });
  });

  it("normalizes a blank label/URL to null", async () => {
    create.mockResolvedValue(row());
    await svc.createChannel("t-1", "e-1", "slack", {
      label: "  ",
      webhookUrl: "",
    });
    expect(create.mock.calls[0][0].data).toMatchObject({
      label: null,
      webhookUrl: null,
    });
  });

  it("rejects an unknown channel type", async () => {
    await expect(
      svc.createChannel("t-1", "e-1", "discord", { enabled: true }),
    ).rejects.toThrow(/Unknown notification channel/);
    expect(create).not.toHaveBeenCalled();
  });

  it("enforces the per-ENV channel cap (another env's channels don't count)", async () => {
    count.mockResolvedValue(MAX_CHANNELS_PER_ENV);
    await expect(svc.createChannel("t-1", "e-1", "slack", {})).rejects.toThrow(
      /limit reached/,
    );
    expect(count.mock.calls[0][0].where).toEqual({
      tenantId: "t-1",
      environmentId: "e-1",
    });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("NotificationsService.updateChannel", () => {
  it("patches ONE channel by id, tenant-scoped, and normalizes blanks", async () => {
    findFirst.mockResolvedValue({ id: "ch_1" });
    update.mockResolvedValue(row({ webhookUrl: null }));
    await svc.updateChannel("t-1", "e-1", "ch_1", {
      enabled: true,
      webhookUrl: "  ",
    });
    // Existence check is TENANT+ENV-scoped (id alone would be a cross-tenant/env hole).
    expect(findFirst.mock.calls[0][0].where).toEqual({
      id: "ch_1",
      tenantId: "t-1",
      environmentId: "e-1",
    });
    expect(update.mock.calls[0][0]).toMatchObject({
      where: { id: "ch_1" },
      data: { enabled: true, webhookUrl: null },
    });
  });

  it("404s for another tenant's (or unknown) channel id", async () => {
    findFirst.mockResolvedValue(null);
    await expect(
      svc.updateChannel("t-1", "e-1", "ch_other", { enabled: false }),
    ).rejects.toThrow(/Unknown notification channel/);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("NotificationsService.deleteChannel", () => {
  it("deletes by id, tenant+env-scoped (idempotent)", async () => {
    deleteMany.mockResolvedValue({ count: 1 });
    await svc.deleteChannel("t-1", "e-1", "ch_1");
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: "ch_1", tenantId: "t-1", environmentId: "e-1" },
    });
  });
});

describe("NotificationsService.sendTest", () => {
  it("404s for an unknown channel id", async () => {
    findFirst.mockResolvedValue(null);
    await expect(svc.sendTest("t-1", "e-1", "ch_ghost")).rejects.toThrow(
      /Unknown notification channel/,
    );
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("400s (and never fetches) when the channel has no webhook", async () => {
    findFirst.mockResolvedValue(row({ webhookUrl: null }));
    await expect(svc.sendTest("t-1", "e-1", "ch_1")).rejects.toThrow(
      /No webhook URL/,
    );
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("POSTs Slack blocks for a slack channel and reports ok on 2xx", async () => {
    findFirst.mockResolvedValue(row());
    const out = await svc.sendTest("t-1", "e-1", "ch_1");
    expect(out).toEqual({ ok: true, status: 200 });
    expect(assertEgressAllowed).toHaveBeenCalledWith(
      "https://hooks.slack.com/x",
    );
    const body = JSON.parse(safeFetch.mock.calls[0][1].body);
    expect(body.blocks[0].type).toBe("header"); // Slack shape, not the Teams envelope
    expect(body.type).toBeUndefined();
  });

  it("POSTs a Teams Adaptive Card envelope for a teams channel", async () => {
    findFirst.mockResolvedValue(
      row({ type: "teams", webhookUrl: "https://teams.example/x" }),
    );
    await svc.sendTest("t-1", "e-1", "ch_1");
    const body = JSON.parse(safeFetch.mock.calls[0][1].body);
    expect(body.type).toBe("message");
    expect(body.attachments[0].contentType).toBe(
      "application/vnd.microsoft.card.adaptive",
    );
  });

  it("maps a blocked (SSRF) URL to a 400 without fetching", async () => {
    findFirst.mockResolvedValue(
      row({ webhookUrl: "https://169.254.169.254/x" }),
    );
    assertEgressAllowed.mockRejectedValue(
      new BlockedEgressError("host resolves to a private/reserved address"),
    );
    await expect(svc.sendTest("t-1", "e-1", "ch_1")).rejects.toThrow(
      /isn't allowed/,
    );
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("surfaces a non-2xx webhook response as a 400", async () => {
    findFirst.mockResolvedValue(
      row({ type: "teams", webhookUrl: "https://teams.example/x" }),
    );
    safeFetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(svc.sendTest("t-1", "e-1", "ch_1")).rejects.toThrow(
      /responded 404/,
    );
  });
});
