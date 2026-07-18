import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { WorkersController } from "../src/workers/workers.controller";
import {
  WORKER_STALE_MS,
  toWorkerResponse,
} from "../src/workers/workers.service";

const row = (lastSeen: Date) => ({
  identity: "host-a/12/v0.0.10",
  host: "host-a",
  version: "v0.0.10",
  taskQueue: "orchestrator",
  activeActivities: 3,
  maxActivities: 100,
  lastSeen,
});

describe("toWorkerResponse", () => {
  const now = Date.parse("2026-08-02T12:00:00.000Z");

  it("maps the fields + live slot usage and marks a recent beat online", () => {
    const out = toWorkerResponse(row(new Date(now - 5_000)), now);
    expect(out).toEqual({
      identity: "host-a/12/v0.0.10",
      host: "host-a",
      version: "v0.0.10",
      taskQueue: "orchestrator",
      activeActivities: 3,
      maxActivities: 100,
      online: true,
      lastSeen: new Date(now - 5_000).toISOString(),
    });
  });

  it("marks a replica offline once lastSeen exceeds the staleness window", () => {
    expect(
      toWorkerResponse(row(new Date(now - WORKER_STALE_MS - 1)), now).online,
    ).toBe(false);
    expect(
      toWorkerResponse(row(new Date(now - WORKER_STALE_MS + 1)), now).online,
    ).toBe(true);
  });
});

describe("WorkersController (owner/admin only)", () => {
  it("returns the fleet for an owner", async () => {
    const service = { list: vi.fn().mockResolvedValue([{ identity: "w1" }]) };
    const ctrl = new WorkersController(service as never);
    const out = await ctrl.list({ tenantId: "t", role: "owner" } as never);
    expect(out).toEqual([{ identity: "w1" }]);
    expect(service.list).toHaveBeenCalledOnce();
  });

  it("allows admin", async () => {
    const service = { list: vi.fn().mockResolvedValue([]) };
    const ctrl = new WorkersController(service as never);
    await expect(
      ctrl.list({ tenantId: "t", role: "admin" } as never),
    ).resolves.toEqual([]);
  });

  it("403s a non-owner/admin (fleet data is operator-only)", async () => {
    const service = { list: vi.fn() };
    const ctrl = new WorkersController(service as never);
    await expect(
      ctrl.list({ tenantId: "t", role: "member" } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.list).not.toHaveBeenCalled();
  });
});
