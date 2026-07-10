import { ConflictException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

// executions.service touches getPrisma (Execution create) + metrics; the gate short-circuits
// BEFORE any of that when inactive, so a minimal mock suffices.
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ execution: { create: vi.fn() } }),
}));
vi.mock("@naary/usage", () => ({ getBudget: async () => null }));

import { ExecutionsService } from "../src/executions/executions.service";

const snapshot = {
  graph: { startNodeId: "s", nodes: [], edges: [] },
  contentHash: "h",
  version: 1,
};

function makeService(isActive: boolean) {
  const graphs = {
    isActive: vi.fn().mockResolvedValue(isActive),
    getErrorHandler: vi.fn().mockResolvedValue(null),
  };
  const service = new ExecutionsService(graphs as never);
  const start = vi.fn().mockResolvedValue(undefined);
  (service as unknown as { client: unknown }).client = {
    workflow: { start },
  };
  return { service, start, graphs };
}

beforeEach(() => vi.clearAllMocks());

describe("automatic-trigger activation gate", () => {
  it("startWebhook is REFUSED (409) for a deactivated workflow — no run started", async () => {
    const { service, start } = makeService(false);
    await expect(
      service.startWebhook("t-1", snapshot as never, {}, "w"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(start).not.toHaveBeenCalled();
  });

  it("startForm is REFUSED (409) for a deactivated workflow — no run started", async () => {
    const { service, start } = makeService(false);
    await expect(
      service.startForm("t-1", snapshot as never, {}, "w"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(start).not.toHaveBeenCalled();
  });

  it("an ACTIVE workflow is not blocked by the gate (it proceeds to start)", async () => {
    const { service, start } = makeService(true);
    await service.startWebhook("t-1", snapshot as never, {}, "w");
    expect(start).toHaveBeenCalledOnce();
  });
});
