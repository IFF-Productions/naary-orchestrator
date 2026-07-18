import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { NotificationsController } from "../src/notifications/notifications.controller";
import type { EnvironmentsService } from "../src/environments/environments.service";
import type { NotificationsService } from "../src/notifications/notifications.service";
import { CreateNotificationChannelDto } from "../src/notifications/notification.dto";

// Env-scoping happens at the controller boundary (Slice 6b): every handler resolves the
// X-Environment-Id selector via resolveEnvId and hands the service a RESOLVED env id.
function make() {
  const notifications = {
    list: vi.fn().mockResolvedValue([]),
    createChannel: vi.fn().mockResolvedValue({ id: "ch_1" }),
    updateChannel: vi.fn().mockResolvedValue({ id: "ch_1" }),
    deleteChannel: vi.fn().mockResolvedValue(undefined),
    sendTest: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
  };
  const environments = {
    resolveEnvId: vi.fn().mockResolvedValue("env-resolved"),
  };
  const controller = new NotificationsController(
    notifications as unknown as NotificationsService,
    environments as unknown as EnvironmentsService,
  );
  return { controller, notifications, environments };
}

describe("NotificationsController env scoping", () => {
  it("list resolves the env selector and passes the RESOLVED id to the service", async () => {
    const { controller, notifications, environments } = make();
    await controller.list("t-1", "sandbox");
    expect(environments.resolveEnvId).toHaveBeenCalledWith("t-1", "sandbox");
    expect(notifications.list).toHaveBeenCalledWith("t-1", "env-resolved");
  });

  it("an ABSENT selector still resolves (tenant default) — pre-6b behavior preserved", async () => {
    const { controller, notifications, environments } = make();
    await controller.list("t-1", undefined);
    expect(environments.resolveEnvId).toHaveBeenCalledWith("t-1", undefined);
    expect(notifications.list).toHaveBeenCalledWith("t-1", "env-resolved");
  });

  it("createChannel stamps the resolved env (type split from the patch)", async () => {
    const { controller, notifications } = make();
    const dto = Object.assign(new CreateNotificationChannelDto(), {
      type: "slack",
      label: "#oncall",
    });
    await controller.createChannel("t-1", dto, "sandbox");
    expect(notifications.createChannel).toHaveBeenCalledWith(
      "t-1",
      "env-resolved",
      "slack",
      { label: "#oncall" },
    );
  });

  it("update/delete/test are all env-scoped through the same resolution", async () => {
    const { controller, notifications, environments } = make();
    await controller.updateChannel("t-1", "ch_1", { enabled: false }, "uat");
    await controller.deleteChannel("t-1", "ch_1", "uat");
    await controller.sendTest("t-1", "ch_1", "uat");
    expect(environments.resolveEnvId).toHaveBeenCalledTimes(3);
    expect(notifications.updateChannel).toHaveBeenCalledWith(
      "t-1",
      "env-resolved",
      "ch_1",
      { enabled: false },
    );
    expect(notifications.deleteChannel).toHaveBeenCalledWith(
      "t-1",
      "env-resolved",
      "ch_1",
    );
    expect(notifications.sendTest).toHaveBeenCalledWith(
      "t-1",
      "env-resolved",
      "ch_1",
    );
  });
});
