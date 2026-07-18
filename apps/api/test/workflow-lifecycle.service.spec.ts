import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowLifecycleService } from "../src/graphs/workflow-lifecycle.service";

/**
 * The consolidated save/delete path shared by graphs.controller and v1-workflows.controller
 * (was duplicated inline in both — the TODO(consolidate)). Pins the two invariants the
 * controllers used to carry each:
 * - DEFAULT-ENV-ONLY gating: schedules aren't env-scoped yet, so sync/teardown must never
 *   run for a non-default (sandbox) env — it would clobber the default/prod copy's triggers.
 * - Best-effort side-effects: a scheduling hiccup must not fail the save/delete.
 */

const graphs = { upsert: vi.fn(), deleteWorkflow: vi.fn() };
const schedules = {
  syncPollSchedule: vi.fn(),
  syncCronSchedule: vi.fn(),
  teardownForWorkflow: vi.fn(),
};
const environments = { isDefaultEnv: vi.fn() };

const GRAPH = { nodes: [], edges: [], startNodeId: "start" } as never;

let svc: WorkflowLifecycleService;
beforeEach(() => {
  vi.clearAllMocks();
  environments.isDefaultEnv.mockResolvedValue(true);
  schedules.syncPollSchedule.mockResolvedValue(undefined);
  schedules.syncCronSchedule.mockResolvedValue(undefined);
  schedules.teardownForWorkflow.mockResolvedValue(undefined);
  svc = new WorkflowLifecycleService(
    graphs as never,
    schedules as never,
    environments as never,
  );
});

describe("saveWorkflow", () => {
  it("upserts, then syncs poll+cron schedules in the DEFAULT env", async () => {
    graphs.upsert.mockResolvedValue({ version: 2, contentHash: "h" });

    const snap = await svc.saveWorkflow("t-1", "env-1", "k", "K", GRAPH);

    expect(graphs.upsert).toHaveBeenCalledWith("t-1", "env-1", "k", "K", GRAPH);
    expect(environments.isDefaultEnv).toHaveBeenCalledWith("t-1", "env-1");
    expect(schedules.syncPollSchedule).toHaveBeenCalledWith("t-1", "k", GRAPH);
    expect(schedules.syncCronSchedule).toHaveBeenCalledWith("t-1", "k", GRAPH);
    expect(snap).toEqual({ version: 2, contentHash: "h" });
  });

  it("does NOT sync schedules for a non-default env (would clobber prod triggers)", async () => {
    graphs.upsert.mockResolvedValue({ version: 1, contentHash: "h" });
    environments.isDefaultEnv.mockResolvedValue(false);

    await svc.saveWorkflow("t-1", "env-sandbox", "k", "K", GRAPH);

    expect(schedules.syncPollSchedule).not.toHaveBeenCalled();
    expect(schedules.syncCronSchedule).not.toHaveBeenCalled();
  });

  it("schedule sync is best-effort — a scheduling failure never fails the save", async () => {
    graphs.upsert.mockResolvedValue({ version: 1, contentHash: "h" });
    schedules.syncPollSchedule.mockRejectedValue(new Error("temporal down"));
    schedules.syncCronSchedule.mockRejectedValue(new Error("temporal down"));

    await expect(
      svc.saveWorkflow("t-1", "env-1", "k", "K", GRAPH),
    ).resolves.toEqual({ version: 1, contentHash: "h" });
  });

  it("an invalid graph fails the upsert and never touches schedules", async () => {
    graphs.upsert.mockRejectedValue(new Error("Invalid graph"));

    await expect(
      svc.saveWorkflow("t-1", "env-1", "k", "K", GRAPH),
    ).rejects.toThrow("Invalid graph");
    expect(schedules.syncPollSchedule).not.toHaveBeenCalled();
    expect(schedules.syncCronSchedule).not.toHaveBeenCalled();
  });
});

describe("deleteWorkflow", () => {
  it("default env: tears down schedules and passes deleteShared=true", async () => {
    graphs.deleteWorkflow.mockResolvedValue(true);

    const out = await svc.deleteWorkflow("t-1", "env-1", "k");

    expect(schedules.teardownForWorkflow).toHaveBeenCalledWith("t-1", "k");
    expect(graphs.deleteWorkflow).toHaveBeenCalledWith(
      "t-1",
      "env-1",
      "k",
      true,
    );
    expect(out).toBe(true);
  });

  it("non-default env: no teardown and deleteShared=false", async () => {
    environments.isDefaultEnv.mockResolvedValue(false);
    graphs.deleteWorkflow.mockResolvedValue(true);

    await svc.deleteWorkflow("t-1", "env-sandbox", "k");

    expect(schedules.teardownForWorkflow).not.toHaveBeenCalled();
    expect(graphs.deleteWorkflow).toHaveBeenCalledWith(
      "t-1",
      "env-sandbox",
      "k",
      false,
    );
  });

  it("teardown is best-effort — a Temporal failure never blocks the delete", async () => {
    schedules.teardownForWorkflow.mockRejectedValue(new Error("temporal down"));
    graphs.deleteWorkflow.mockResolvedValue(true);

    await expect(svc.deleteWorkflow("t-1", "env-1", "k")).resolves.toBe(true);
  });

  it("returns false (caller 404s) when the key doesn't exist in the env", async () => {
    graphs.deleteWorkflow.mockResolvedValue(false);
    await expect(svc.deleteWorkflow("t-1", "env-1", "gone")).resolves.toBe(
      false,
    );
  });
});
