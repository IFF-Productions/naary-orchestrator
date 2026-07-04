import type { GraphDef } from "@naary/dsl";
import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn();
vi.mock("@naary/db", () => ({ getPrisma: () => ({ schedule: { upsert } }) }));
vi.mock("@naary/usage", () => ({ getBudget: async () => null }));

import { SchedulesService } from "../src/schedules/schedules.service";

const create = vi.fn();
const del = vi.fn();

function makeService(getLatest: () => Promise<unknown>): SchedulesService {
  const service = new SchedulesService({ getLatest } as never);
  (service as unknown as { client: unknown }).client = {
    schedule: { create, getHandle: () => ({ delete: del }) },
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
});
