import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const upsert = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ notificationSettings: { findUnique, upsert } }),
}));

import { NotificationsService } from "../src/notifications/notifications.service";

const svc = new NotificationsService();

beforeEach(() => {
  findUnique.mockReset();
  upsert.mockReset();
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
