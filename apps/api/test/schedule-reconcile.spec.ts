import type { GraphDef } from "@naary/dsl";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One-time boot reconcile of LEGACY (no-env) schedule ids (env-scoped-schedules cutover):
 * every Schedule row whose Temporal id predates the env segment is recreated under the
 * env-scoped identity and the legacy Temporal schedule + row are removed. Detection works
 * because the migration backfilled `environmentId` on every row while the id string kept
 * its old format — a legacy id never contains the row's env id.
 */

const findMany = vi.fn();
const findUnique = vi.fn();
const upsert = vi.fn();
const deleteMany = vi.fn();
const rowCreate = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    schedule: { findMany, findUnique, upsert, deleteMany, create: rowCreate },
  }),
}));
vi.mock("@naary/usage", () => ({ getBudget: async () => null }));

import { ScheduleReconcileService } from "../src/schedules/schedule-reconcile.service";
import { SchedulesService } from "../src/schedules/schedules.service";

const createSchedule = vi.fn();
const del = vi.fn();
const pause = vi.fn();
let deletedIds: string[] = [];

const pollGraph: GraphDef = {
  startNodeId: "poll",
  nodes: [
    {
      id: "poll",
      type: "pollTrigger",
      config: { url: "https://x/y", intervalSeconds: 60 },
    },
    { id: "end", type: "end" },
  ],
  edges: [{ from: "poll", to: "end" }],
};

function makeService(
  getLatest: (
    tenantId: string,
    environmentId: string,
    workflowKey: string,
  ) => Promise<unknown>,
): SchedulesService {
  const service = new SchedulesService({
    getLatest,
    isActive: async () => true,
  } as never);
  (service as unknown as { client: unknown }).client = {
    schedule: {
      create: createSchedule,
      getHandle: (id: string) => ({
        delete: () => {
          deletedIds.push(id);
          return del(id);
        },
        pause,
        unpause: vi.fn(),
        describe: vi.fn().mockResolvedValue({ state: { paused: false } }),
      }),
    },
  };
  return service;
}

const legacyPollRow = {
  id: "poll-t-1-wf",
  tenantId: "t-1",
  environmentId: "e-prod",
  workflowKey: "wf",
  cron: "every 60s",
  paused: false,
  createdAt: new Date("2026-01-01"),
};
const legacyUserRow = {
  id: "sched-t-1-wf-deadbeef",
  tenantId: "t-1",
  environmentId: "e-prod",
  workflowKey: "wf",
  cron: "0 9 * * *",
  paused: true,
  createdAt: new Date("2026-01-02"),
};
const newFormatRow = {
  id: "poll-t-1-e-prod-wf",
  tenantId: "t-1",
  environmentId: "e-prod",
  workflowKey: "wf",
  cron: "every 60s",
  paused: false,
  createdAt: new Date("2026-01-03"),
};

beforeEach(() => {
  deletedIds = [];
  findMany.mockReset().mockResolvedValue([]);
  // The sync-path ownership guard looks the legacy row up by id — serve it from the same
  // fixture set the reconcile read, so ownership matches the row's own env.
  findUnique
    .mockReset()
    .mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        [legacyPollRow, legacyUserRow, newFormatRow].find(
          (r) => r.id === where.id,
        ) ?? null,
    );
  upsert.mockReset().mockResolvedValue(undefined);
  deleteMany.mockReset().mockResolvedValue({ count: 0 });
  rowCreate.mockReset().mockResolvedValue(undefined);
  createSchedule.mockReset().mockResolvedValue(undefined);
  del.mockReset().mockResolvedValue(undefined);
  pause.mockReset().mockResolvedValue(undefined);
});

describe("SchedulesService.reconcileLegacyScheduleIds", () => {
  it("migrates a legacy auto (poll-) row: new env-scoped schedule created, legacy id + row deleted", async () => {
    findMany.mockResolvedValue([legacyPollRow]);
    const getLatest = vi.fn(async () => ({
      graph: pollGraph,
      contentHash: "h",
      version: 2,
    }));
    const service = makeService(getLatest);

    const out = await service.reconcileLegacyScheduleIds();

    expect(out).toEqual({ migrated: 1, failed: 0 });
    // Snapshot read in the ROW'S env.
    expect(getLatest).toHaveBeenCalledWith("t-1", "e-prod", "wf");
    // New-format Temporal schedule created, env threaded into the action args.
    const opts = createSchedule.mock.calls[0][0];
    expect(opts.scheduleId).toBe("poll-t-1-e-prod-wf");
    expect(opts.action.args[2]).toMatchObject({
      tenantId: "t-1",
      environmentId: "e-prod",
      workflowKey: "wf",
    });
    // Legacy Temporal schedule + DB row are gone.
    expect(deletedIds).toContain("poll-t-1-wf");
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: "poll-t-1-wf" } });
  });

  it("migrates a legacy USER (sched-) row: DETERMINISTIC env-scoped id, cron + paused preserved", async () => {
    findMany.mockResolvedValue([legacyUserRow]);
    const service = makeService(async () => ({
      graph: pollGraph,
      contentHash: "h",
      version: 2,
    }));

    const out = await service.reconcileLegacyScheduleIds();

    expect(out).toEqual({ migrated: 1, failed: 0 });
    const opts = createSchedule.mock.calls[0][0];
    // Deterministic: the legacy id's uuid suffix carries over, so concurrent replica boots
    // converge on the SAME schedule instead of minting duplicates.
    expect(opts.scheduleId).toBe("sched-t-1-e-prod-wf-deadbeef");
    expect(opts.spec.cronExpressions).toEqual(["0 9 * * *"]);
    expect(opts.action.args[2]).toMatchObject({ environmentId: "e-prod" });
    // Row was paused → the recreated schedule is paused too (no surprise firing).
    expect(pause).toHaveBeenCalled();
    // Upsert (not create) so a crash-retry that got this far converges on the same row.
    const userUpsert = upsert.mock.calls.find(
      (c) => c[0]?.where?.id === "sched-t-1-e-prod-wf-deadbeef",
    );
    expect(userUpsert?.[0].create).toMatchObject({
      environmentId: "e-prod",
      cron: "0 9 * * *",
      paused: true,
      createdAt: legacyUserRow.createdAt, // original creation time preserved
    });
    expect(deletedIds).toContain("sched-t-1-wf-deadbeef");
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: "sched-t-1-wf-deadbeef" },
    });
  });

  it("user-row migration converges when the new Temporal schedule ALREADY exists (replica race)", async () => {
    findMany.mockResolvedValue([legacyUserRow]);
    createSchedule.mockRejectedValue(new Error("schedule already exists"));
    // describe() on the deterministic new id succeeds → the other replica created it.
    const service = makeService(async () => ({
      graph: pollGraph,
      contentHash: "h",
      version: 2,
    }));

    const out = await service.reconcileLegacyScheduleIds();

    expect(out).toEqual({ migrated: 1, failed: 0 }); // convergence, not failure
    expect(deletedIds).toContain("sched-t-1-wf-deadbeef"); // legacy still cleaned up
  });

  it("an ORPHAN legacy row (graph gone) still has its legacy schedule + row removed", async () => {
    findMany.mockResolvedValue([legacyPollRow]);
    const service = makeService(async () => null);

    const out = await service.reconcileLegacyScheduleIds();

    expect(out).toEqual({ migrated: 1, failed: 0 });
    expect(createSchedule).not.toHaveBeenCalled(); // nothing to recreate
    expect(deletedIds).toContain("poll-t-1-wf");
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: "poll-t-1-wf" } });
  });

  it("is IDEMPOTENT: new-format rows are untouched; a second run no-ops", async () => {
    findMany.mockResolvedValue([newFormatRow]);
    const service = makeService(async () => ({
      graph: pollGraph,
      contentHash: "h",
      version: 2,
    }));

    const out = await service.reconcileLegacyScheduleIds();

    expect(out).toEqual({ migrated: 0, failed: 0 });
    expect(createSchedule).not.toHaveBeenCalled();
    expect(deletedIds).toEqual([]);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("one bad row doesn't strand the rest (per-row best-effort, counted as failed)", async () => {
    findMany.mockResolvedValue([legacyPollRow, legacyUserRow]);
    // First row's schedule creation blows up; second must still migrate.
    createSchedule
      .mockRejectedValueOnce(new Error("temporal hiccup"))
      .mockResolvedValue(undefined);
    const service = makeService(async () => ({
      graph: pollGraph,
      contentHash: "h",
      version: 2,
    }));

    const out = await service.reconcileLegacyScheduleIds();

    expect(out).toEqual({ migrated: 1, failed: 1 });
    expect(deletedIds).toContain("sched-t-1-wf-deadbeef");
  });
});

describe("ScheduleReconcileService (boot wrapper)", () => {
  it("logs counts on success and never throws", async () => {
    findMany.mockResolvedValue([]);
    const service = makeService(async () => null);
    const wrapper = new ScheduleReconcileService(service);

    await expect(wrapper.run()).resolves.toBeUndefined();
  });

  it("Temporal/DB down → warns, does NOT throw (boot must not die)", async () => {
    findMany.mockRejectedValue(new Error("db unreachable"));
    const service = makeService(async () => null);
    const wrapper = new ScheduleReconcileService(service);

    await expect(wrapper.run()).resolves.toBeUndefined();
  });

  it("onApplicationBootstrap is fire-and-forget (returns synchronously)", () => {
    findMany.mockResolvedValue([]);
    const service = makeService(async () => null);
    const wrapper = new ScheduleReconcileService(service);

    expect(wrapper.onApplicationBootstrap()).toBeUndefined();
  });
});
