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
  it("returns safe defaults (no webhook, both events on) when unset", async () => {
    findUnique.mockResolvedValue(null);
    expect(await svc.get("t-1")).toEqual({
      webhookUrl: null,
      onApprovalPending: true,
      onRunFailed: true,
    });
  });

  it("returns the stored settings", async () => {
    findUnique.mockResolvedValue({
      webhookUrl: "https://h/x",
      onApprovalPending: false,
      onRunFailed: true,
    });
    expect(await svc.get("t-1")).toEqual({
      webhookUrl: "https://h/x",
      onApprovalPending: false,
      onRunFailed: true,
    });
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
