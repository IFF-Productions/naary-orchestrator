import type { GraphDef } from "@naary/dsl";
import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn();
const findMany = vi.fn();
const updateMany = vi.fn();
const findUnique = vi.fn();
const update = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    schedule: { upsert, findMany, updateMany, findUnique, update },
  }),
}));
vi.mock("@naary/usage", () => ({ getBudget: async () => null }));

import { SchedulesService } from "../src/schedules/schedules.service";

const create = vi.fn();
const del = vi.fn();
const pause = vi.fn();
const unpause = vi.fn();
const describeHandle = vi.fn();
const triggerNow = vi.fn();
const setActiveFlag = vi.fn();

function makeService(
  getLatest: () => Promise<unknown>,
  isActive: () => Promise<boolean> = async () => true,
): SchedulesService {
  const service = new SchedulesService(
    {
      getLatest,
      isActive,
      setActive: setActiveFlag,
    } as never,
    { defaultEnvId: async () => "e1", resolveEnvId: async () => "e1" } as never,
  );
  (service as unknown as { client: unknown }).client = {
    schedule: {
      create,
      getHandle: () => ({
        delete: del,
        pause,
        unpause,
        describe: describeHandle,
        trigger: triggerNow,
      }),
    },
  };
  return service;
}

function pollGraph(intervalSeconds: number): GraphDef {
  return {
    startNodeId: "poll",
    nodes: [
      {
        id: "poll",
        type: "pollTrigger",
        config: { url: "https://x/y", intervalSeconds },
      },
      { id: "end", type: "end" },
    ],
    edges: [{ from: "poll", to: "end" }],
  };
}

const plainGraph: GraphDef = {
  startNodeId: "start",
  nodes: [
    { id: "start", type: "start" },
    { id: "end", type: "end" },
  ],
  edges: [{ from: "start", to: "end" }],
};

beforeEach(() => {
  create.mockReset();
  del.mockReset().mockResolvedValue(undefined);
  upsert.mockReset().mockResolvedValue(undefined);
  findMany.mockReset().mockResolvedValue([]);
  updateMany.mockReset().mockResolvedValue({ count: 0 });
  pause.mockReset().mockResolvedValue(undefined);
  unpause.mockReset().mockResolvedValue(undefined);
  describeHandle.mockReset().mockResolvedValue({ state: { paused: false } });
  triggerNow.mockReset().mockResolvedValue(undefined);
  setActiveFlag.mockReset().mockResolvedValue(undefined);
  findUnique.mockReset();
  update.mockReset().mockResolvedValue(undefined);
});

describe("syncPollSchedule", () => {
  it("creates an INTERVAL schedule for a pollTrigger graph", async () => {
    const g = pollGraph(300);
    const service = makeService(async () => ({
      graph: g,
      contentHash: "h",
      version: 1,
    }));

    await service.syncPollSchedule("t-1", "poller", g);

    expect(create).toHaveBeenCalledOnce();
    const opts = create.mock.calls[0][0];
    expect(opts.scheduleId).toBe("poll-t-1-poller");
    expect(opts.spec.intervals[0].every).toBe(300_000); // seconds → ms
    expect(opts.action.workflowType).toBeTruthy();
    expect(upsert).toHaveBeenCalledOnce();
  });

  it("floors the interval at 30s (a too-frequent poll can't hammer the source)", async () => {
    const g = pollGraph(5);
    const service = makeService(async () => ({
      graph: g,
      contentHash: "h",
      version: 1,
    }));

    await service.syncPollSchedule("t-1", "poller", g);

    expect(create.mock.calls[0][0].spec.intervals[0].every).toBe(30_000);
  });

  it("is a NO-OP for a non-pollTrigger graph (no schedule created)", async () => {
    const service = makeService(async () => ({
      graph: plainGraph,
      contentHash: "h",
      version: 1,
    }));

    await service.syncPollSchedule("t-1", "canvas", plainGraph);

    expect(create).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  // The invariant the advisor flagged: the delete-then-create on save makes a fresh (unpaused)
  // schedule, so editing a DEACTIVATED workflow would silently re-arm its trigger. It must be
  // re-paused, and the row recorded paused.
  it("re-pauses the freshly-created schedule when the workflow is INACTIVE (save can't re-arm)", async () => {
    const g = pollGraph(300);
    const service = makeService(
      async () => ({ graph: g, contentHash: "h", version: 1 }),
      async () => false, // workflow is deactivated
    );

    await service.syncPollSchedule("t-1", "poller", g);

    expect(create).toHaveBeenCalledOnce(); // schedule (re)created…
    expect(pause).toHaveBeenCalledOnce(); // …then immediately paused
    expect(upsert.mock.calls[0][0].create.paused).toBe(true);
    expect(upsert.mock.calls[0][0].update.paused).toBe(true);
  });

  it("leaves the schedule running when the workflow is ACTIVE (default)", async () => {
    const g = pollGraph(300);
    const service = makeService(async () => ({
      graph: g,
      contentHash: "h",
      version: 1,
    }));

    await service.syncPollSchedule("t-1", "poller", g);

    expect(pause).not.toHaveBeenCalled();
    expect(upsert.mock.calls[0][0].create.paused).toBe(false);
  });
});

describe("setActive (workflow activation ↔ its schedules)", () => {
  it("DEACTIVATE pauses every schedule for the workflow, THEN writes flag=false", async () => {
    findMany.mockResolvedValue([{ id: "poll-t-1-w" }, { id: "cron-t-1-w" }]);
    const service = makeService(async () => null);

    await service.setActive("t-1", "e1", "w", false);

    expect(pause).toHaveBeenCalledTimes(2); // both schedules paused
    expect(updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t-1", workflowKey: "w" },
      data: { paused: true },
    });
    expect(setActiveFlag).toHaveBeenCalledWith("t-1", "e1", "w", false);
    // ordering: schedules paused before the flag flips (nothing fires against intent)
    expect(pause.mock.invocationCallOrder[0]).toBeLessThan(
      setActiveFlag.mock.invocationCallOrder[0],
    );
  });

  it("ACTIVATE writes flag=true FIRST, then unpauses the schedules", async () => {
    findMany.mockResolvedValue([{ id: "poll-t-1-w" }]);
    const service = makeService(async () => null);

    await service.setActive("t-1", "e1", "w", true);

    expect(setActiveFlag).toHaveBeenCalledWith("t-1", "e1", "w", true);
    expect(unpause).toHaveBeenCalledOnce();
    expect(setActiveFlag.mock.invocationCallOrder[0]).toBeLessThan(
      unpause.mock.invocationCallOrder[0],
    );
  });

  // HIGH-2: a REAL pause failure (schedule exists, describe succeeds) must ABORT deactivation —
  // never write flag=false while the schedule is still firing.
  it("DEACTIVATE aborts (throws, flag NOT written) if a real pause fails", async () => {
    findMany.mockResolvedValue([{ id: "poll-t-1-w" }]);
    pause.mockRejectedValue(new Error("temporal unavailable"));
    describeHandle.mockResolvedValue({ state: { paused: false } }); // schedule still exists → real error
    const service = makeService(async () => null);

    await expect(service.setActive("t-1", "e1", "w", false)).rejects.toThrow(
      /temporal unavailable/,
    );
    expect(setActiveFlag).not.toHaveBeenCalled(); // flag stays active — fail-closed
  });

  it("DEACTIVATE tolerates a genuinely-missing schedule (describe also fails)", async () => {
    findMany.mockResolvedValue([{ id: "poll-t-1-w" }]);
    pause.mockRejectedValue(new Error("not found"));
    describeHandle.mockRejectedValue(new Error("not found")); // schedule is gone → nothing to pause
    const service = makeService(async () => null);

    await service.setActive("t-1", "e1", "w", false); // does not throw
    expect(setActiveFlag).toHaveBeenCalledWith("t-1", "e1", "w", false);
  });
});

describe("setPaused / trigger respect activation (HIGH-1 + LOW)", () => {
  it("setPaused REFUSES to resume a schedule when the workflow is inactive (no re-arm)", async () => {
    findUnique.mockResolvedValue({ tenantId: "t-1", workflowKey: "w" });
    const service = makeService(
      async () => null,
      async () => false,
    );

    await expect(service.setPaused("t-1", "poll-t-1-w", false)).rejects.toThrow(
      /inactive/,
    );
    expect(unpause).not.toHaveBeenCalled();
  });

  it("setPaused still allows PAUSING (and resuming an active workflow)", async () => {
    findUnique.mockResolvedValue({ tenantId: "t-1", workflowKey: "w" });
    update.mockResolvedValue(undefined);
    const service = makeService(
      async () => null,
      async () => true,
    );

    await service.setPaused("t-1", "poll-t-1-w", false); // active → allowed
    expect(unpause).toHaveBeenCalledOnce();
  });

  it("trigger is refused for an inactive workflow", async () => {
    findUnique.mockResolvedValue({ tenantId: "t-1", workflowKey: "w" });
    const service = makeService(
      async () => null,
      async () => false,
    );

    await expect(service.trigger("t-1", "poll-t-1-w")).rejects.toThrow(
      /inactive/,
    );
    expect(triggerNow).not.toHaveBeenCalled();
  });
});
