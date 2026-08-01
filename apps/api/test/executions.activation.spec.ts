import { ConflictException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

// executions.service touches getPrisma (Execution create) + metrics; the gate short-circuits
// BEFORE any of that when inactive, so a minimal mock suffices.
vi.mock("@naary/db", () => ({
  // #904: this spec has no renamed workflows, so the alias resolver is the identity. A spec
  // that DOES exercise aliases stubs it to return the live key (see workflow-key-alias.spec.ts).
  resolveWorkflowKey: async (_t: string, k: string) => k,
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
    // startMcpTrigger resolves the snapshot itself (unlike startForm/startWebhook which are
    // handed one) — only reached when the gate PASSES.
    getLatest: vi.fn().mockResolvedValue(snapshot),
  };
  const service = new ExecutionsService(
    graphs as never,
    {
      defaultEnvId: async () => "env-test",
      resolveEnvId: async () => "env-test",
    } as never,
  );
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
      service.startWebhook("t-1", "e-1", snapshot as never, {}, "w"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(start).not.toHaveBeenCalled();
  });

  it("startForm is REFUSED (409) for a deactivated workflow — no run started", async () => {
    const { service, start } = makeService(false);
    await expect(
      service.startForm("t-1", "e-1", snapshot as never, {}, "w"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(start).not.toHaveBeenCalled();
  });

  it("startMcpTrigger is REFUSED (409) for a deactivated workflow — no run started", async () => {
    const { service, start } = makeService(false);
    await expect(
      service.startMcpTrigger("t-1", "e-1", { orderId: "o-1" }, "w"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(start).not.toHaveBeenCalled();
  });

  it("startMcpTrigger proceeds for an ACTIVE workflow (gate checked in the endpoint's env)", async () => {
    const { service, start, graphs } = makeService(true);
    await service.startMcpTrigger("t-1", "e-1", { orderId: "o-1" }, "w");
    expect(start).toHaveBeenCalledOnce();
    expect(graphs.isActive).toHaveBeenCalledWith("t-1", "e-1", "w");
  });

  it("an ACTIVE workflow is not blocked by the gate (it proceeds to start)", async () => {
    const { service, start, graphs } = makeService(true);
    await service.startWebhook("t-1", "e-1", snapshot as never, {}, "w");
    expect(start).toHaveBeenCalledOnce();
    // The activation gate is checked in the endpoint's OWN env, not the default.
    expect(graphs.isActive).toHaveBeenCalledWith("t-1", "e-1", "w");
  });
});
