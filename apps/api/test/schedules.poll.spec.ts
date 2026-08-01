import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GraphDef } from "@naary/dsl";
import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn();
const findMany = vi.fn();
const updateMany = vi.fn();
const findUnique = vi.fn();
const update = vi.fn();
const rowCreate = vi.fn();
const deleteMany = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    schedule: {
      upsert,
      findMany,
      updateMany,
      findUnique,
      update,
      create: rowCreate,
      deleteMany,
    },
  }),
}));
vi.mock("@naary/usage", () => ({ getBudget: async () => null }));

import { SchedulesService } from "../src/schedules/schedules.service";
import { startSampleInput } from "../src/executions/executions.helpers";

const create = vi.fn();
const del = vi.fn();
const pause = vi.fn();
const unpause = vi.fn();
const describeHandle = vi.fn();
const triggerNow = vi.fn();
const setActiveFlag = vi.fn();
/** Every Temporal schedule id a handle.delete() was issued for — legacy-cleanup assertions. */
let deletedIds: string[] = [];

function makeService(
  getLatest: () => Promise<unknown>,
  isActive: () => Promise<boolean> = async () => true,
): SchedulesService {
  const service = new SchedulesService({
    getLatest,
    isActive,
    setActive: setActiveFlag,
  } as never);
  (service as unknown as { client: unknown }).client = {
    schedule: {
      create,
      getHandle: (id: string) => ({
        delete: () => {
          deletedIds.push(id);
          return del(id);
        },
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

function cronGraph(cron: string): GraphDef {
  return {
    startNodeId: "cron",
    nodes: [
      { id: "cron", type: "scheduleTrigger", config: { cron } },
      { id: "end", type: "end" },
    ],
    edges: [{ from: "cron", to: "end" }],
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
  deletedIds = [];
  create.mockReset();
  del.mockReset().mockResolvedValue(undefined);
  upsert.mockReset().mockResolvedValue(undefined);
  findMany.mockReset().mockResolvedValue([]);
  updateMany.mockReset().mockResolvedValue({ count: 0 });
  deleteMany.mockReset().mockResolvedValue({ count: 0 });
  rowCreate.mockReset().mockResolvedValue(undefined);
  pause.mockReset().mockResolvedValue(undefined);
  unpause.mockReset().mockResolvedValue(undefined);
  describeHandle.mockReset().mockResolvedValue({ state: { paused: false } });
  triggerNow.mockReset().mockResolvedValue(undefined);
  setActiveFlag.mockReset().mockResolvedValue(undefined);
  findUnique.mockReset();
  update.mockReset().mockResolvedValue(undefined);
});

describe("syncPollSchedule (env-scoped identity)", () => {
  it("creates an INTERVAL schedule under the env-scoped id, with env in the action args", async () => {
    const g = pollGraph(300);
    const service = makeService(async () => ({
      graph: g,
      contentHash: "h",
      version: 1,
    }));

    await service.syncPollSchedule("t-1", "e1", "poller", g);

    expect(create).toHaveBeenCalledOnce();
    const opts = create.mock.calls[0][0];
    expect(opts.scheduleId).toBe("poll-t-1-e1-poller");
    expect(opts.spec.intervals[0].every).toBe(300_000); // seconds → ms
    expect(opts.action.workflowType).toBeTruthy();
    expect(opts.action.workflowId).toBe("pollrun-t-1-e1-poller");
    // Scheduled runs land IN THEIR ENV — the run ctx carries environmentId now.
    expect(opts.action.args[2]).toMatchObject({
      tenantId: "t-1",
      environmentId: "e1",
      workflowKey: "poller",
    });
    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert.mock.calls[0][0].create.environmentId).toBe("e1");
  });

  it("best-effort-deletes an ORPHAN legacy (no-env) Temporal handle on every sync (cutover safety net)", async () => {
    const g = pollGraph(300);
    findUnique.mockResolvedValue(null); // no registry row for the legacy id
    const service = makeService(async () => ({
      graph: g,
      contentHash: "h",
      version: 1,
    }));

    await service.syncPollSchedule("t-1", "e1", "poller", g);

    expect(deletedIds).toContain("poll-t-1-poller"); // orphan legacy Temporal id
    expect(deletedIds).toContain("poll-t-1-e1-poller"); // delete-then-create of the new id
    expect(deleteMany).not.toHaveBeenCalled(); // no row to delete
  });

  it("clears the legacy id + row when THIS env owns the legacy row", async () => {
    const g = pollGraph(300);
    findUnique.mockResolvedValue({ environmentId: "e1" }); // legacy row owned by e1
    const service = makeService(async () => ({
      graph: g,
      contentHash: "h",
      version: 1,
    }));

    await service.syncPollSchedule("t-1", "e1", "poller", g);

    expect(deletedIds).toContain("poll-t-1-poller");
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: "poll-t-1-poller" },
    });
  });

  it("does NOT touch a legacy id owned by ANOTHER env (sandbox sync can't kill prod's legacy schedule)", async () => {
    const g = pollGraph(300);
    findUnique.mockResolvedValue({ environmentId: "e-prod" }); // legacy row belongs to prod
    const service = makeService(async () => ({
      graph: g,
      contentHash: "h",
      version: 1,
    }));

    await service.syncPollSchedule("t-1", "e-sandbox", "poller", g);

    expect(deletedIds).not.toContain("poll-t-1-poller"); // prod's legacy schedule survives
    expect(deleteMany).not.toHaveBeenCalled();
    // Sandbox's own env-scoped schedule is still created normally.
    expect(create.mock.calls[0][0].scheduleId).toBe(
      "poll-t-1-e-sandbox-poller",
    );
  });

  it("a legacy-delete FAILURE (Temporal hiccup) doesn't break the sync", async () => {
    const g = pollGraph(300);
    del.mockRejectedValue(new Error("not found"));
    const service = makeService(async () => ({
      graph: g,
      contentHash: "h",
      version: 1,
    }));

    await service.syncPollSchedule("t-1", "e1", "poller", g);
    expect(create).toHaveBeenCalledOnce(); // new schedule still created
  });

  it("floors the interval at 30s (a too-frequent poll can't hammer the source)", async () => {
    const g = pollGraph(5);
    const service = makeService(async () => ({
      graph: g,
      contentHash: "h",
      version: 1,
    }));

    await service.syncPollSchedule("t-1", "e1", "poller", g);

    expect(create.mock.calls[0][0].spec.intervals[0].every).toBe(30_000);
  });

  it("is a NO-OP for a non-pollTrigger graph (no schedule created)", async () => {
    const service = makeService(async () => ({
      graph: plainGraph,
      contentHash: "h",
      version: 1,
    }));

    await service.syncPollSchedule("t-1", "e1", "canvas", plainGraph);

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

    await service.syncPollSchedule("t-1", "e1", "poller", g);

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

    await service.syncPollSchedule("t-1", "e1", "poller", g);

    expect(pause).not.toHaveBeenCalled();
    expect(upsert.mock.calls[0][0].create.paused).toBe(false);
  });
});

describe("syncCronSchedule (env-scoped identity)", () => {
  it("creates the cron schedule under the env-scoped id + env in args; clears the legacy id", async () => {
    const g = cronGraph("0 9 * * 1-5");
    const service = makeService(async () => ({
      graph: g,
      contentHash: "h",
      version: 3,
    }));

    await service.syncCronSchedule("t-1", "e1", "reporter", g);

    const opts = create.mock.calls[0][0];
    expect(opts.scheduleId).toBe("cron-t-1-e1-reporter");
    expect(opts.spec.cronExpressions).toEqual(["0 9 * * 1-5"]);
    expect(opts.action.workflowId).toBe("cronrun-t-1-e1-reporter");
    expect(opts.action.args[2]).toMatchObject({
      tenantId: "t-1",
      environmentId: "e1",
      workflowKey: "reporter",
    });
    expect(deletedIds).toContain("cron-t-1-reporter"); // legacy cleanup
    expect(upsert.mock.calls[0][0].create.environmentId).toBe("e1");
  });
});

describe("create (user cron schedule, env-scoped)", () => {
  it("mints an env-scoped sched- id, env-scoped run id, and env in the action args + row", async () => {
    const g = plainGraph;
    const service = makeService(async () => ({
      graph: g,
      contentHash: "h",
      version: 1,
    }));

    const view = await service.create("t-1", "e1", "wf", "0 9 * * *");

    const opts = create.mock.calls[0][0];
    expect(opts.scheduleId).toMatch(/^sched-t-1-e1-wf-[0-9a-f]{8}$/);
    expect(opts.action.workflowId).toBe("schedrun-t-1-e1-wf");
    expect(opts.action.args[2]).toMatchObject({
      tenantId: "t-1",
      environmentId: "e1",
      workflowKey: "wf",
    });
    expect(rowCreate).toHaveBeenCalledOnce();
    expect(rowCreate.mock.calls[0][0].data).toMatchObject({
      tenantId: "t-1",
      environmentId: "e1",
      workflowKey: "wf",
      cron: "0 9 * * *",
    });
    expect(view.id).toBe(opts.scheduleId);
  });
});

/**
 * #991 — ALL FOUR schedule-creation paths start their run with `{}`.
 *
 * #982's body claimed all four already resolved `body.input → sampleInput → {}`. Two did:
 * `create` and the legacy reconcile called `startSampleInput`, while `syncPollSchedule` and
 * `syncCronSchedule` passed a literal `{}` and never consulted it. One graph's two schedules
 * (the cron auto-synced on save, plus any made with `POST /schedules`) could therefore start the
 * SAME run with two different inputs.
 *
 * The fix deletes the `input` parameter from the action builder, so `{}` is the only thing any
 * path can pass. A schedule carries no trigger data — nothing arrives when a cron fires — and
 * `sampleInput` is the MANUAL-run default only, exactly as the canvas tells the author ("Only used
 * when you run this manually"). Feeding it to a schedule would INVERT #979: a production 9am
 * firing carrying whatever an author typed into a field labelled "sample input".
 *
 * Every graph below declares a sample, INCLUDING the schedule/poll ones whose node types refuse
 * the field in the DSL (#990's exclusion) — a graph written straight to the DB could still carry
 * one. That is the point: it pins that the exclusion is no longer the thing holding the
 * divergence shut, so re-opening the field can never silently re-open the split.
 */
describe("scheduled runs carry NO input (#991)", () => {
  /** #979's payload, verbatim — the one a manual run used to inject into a scheduled workflow. */
  const SAMPLE = { message: "I was charged twice this month" };

  /** The same graph, with a `sampleInput` declared on its start node. */
  function withSample(g: GraphDef): GraphDef {
    return {
      ...g,
      nodes: g.nodes.map((n) =>
        n.id === g.startNodeId
          ? { ...n, config: { ...(n.config ?? {}), sampleInput: SAMPLE } }
          : n,
      ),
    };
  }

  /** A webhook graph is the case that is reachable TODAY: `POST /schedules` works on ANY graph,
   *  and #990 gave webhook triggers a `sampleInput`, so its cron used to fire carrying it. */
  const webhookGraph: GraphDef = {
    startNodeId: "hook",
    nodes: [
      { id: "hook", type: "webhookTrigger" },
      { id: "end", type: "end" },
    ],
    edges: [{ from: "hook", to: "end" }],
  };

  const legacyUserRow = {
    id: "sched-t-1-wf-deadbeef", // pre-env-scoped id → the boot reconcile recreates it
    tenantId: "t-1",
    environmentId: "e1",
    workflowKey: "wf",
    cron: "0 9 * * *",
    paused: false,
    createdAt: new Date("2026-01-02"),
  };

  it("all four paths pass {} — even when the graph declares a sampleInput", async () => {
    /** [which path, the run input it handed Temporal]. args = [graph, input, ctx]. */
    const fired: Array<[string, unknown]> = [];
    const drain = (path: string) => {
      for (const call of create.mock.calls)
        fired.push([path, call[0].action.args[1]]);
      create.mockClear();
    };
    const serving = (g: GraphDef) =>
      makeService(async () => ({ graph: g, contentHash: "h", version: 1 }));

    // 1. POST /schedules on a sample-declaring graph (reachable today).
    await serving(withSample(webhookGraph)).create(
      "t-1",
      "e1",
      "wf",
      "0 9 * * *",
    );
    drain("POST /schedules");

    // 2. The interval schedule auto-synced when a poll graph is saved.
    const poll = withSample(pollGraph(60));
    await serving(poll).syncPollSchedule("t-1", "e1", "poller", poll);
    drain("syncPollSchedule");

    // 3. The cron schedule auto-synced when a scheduleTrigger graph is saved.
    const cron = withSample(cronGraph("0 9 * * *"));
    await serving(cron).syncCronSchedule("t-1", "e1", "reporter", cron);
    drain("syncCronSchedule");

    // 4. The one-time boot reconcile recreating a legacy user schedule.
    findMany.mockResolvedValue([legacyUserRow]);
    await serving(withSample(webhookGraph)).reconcileLegacyScheduleIds();
    drain("legacy reconcile");

    // Labelled so a regression names the path that leaked instead of just showing an object.
    expect(fired).toEqual([
      ["POST /schedules", {}],
      ["syncPollSchedule", {}],
      ["syncCronSchedule", {}],
      ["legacy reconcile", {}],
    ]);
  });

  it("a manual run STILL gets the sample — this narrows schedules, not the field", async () => {
    // The counterweight: if `sampleInput` stopped reaching manual runs too, #983 would be undone
    // and the field would be dead config. `startExecution` is the one reader left.
    expect(startSampleInput(withSample(webhookGraph))).toEqual(SAMPLE);
  });

  it("the schedules service no longer reads the sample at all", () => {
    // `startSampleInput` is now the answer to exactly one question — "what does a MANUAL run
    // send" — so the schedules service has no business importing it. A future edit that reaches
    // for it again is the split reopening.
    const src = readFileSync(
      resolve(__dirname, "../src/schedules/schedules.service.ts"),
      "utf8",
    );
    // Whole import STATEMENTS, not lines: the file's own prose explains this history and mentions
    // the name (so a whole-file search would always match), and a `startsWith("import ")` line
    // filter misses the form prettier produces once the clause grows —
    //     import {
    //       startSampleInput,
    //     } from "../executions/executions.helpers";
    // — which would make this guard silently vacuous the day a second symbol is imported.
    const statements = src.match(/^import[\s\S]*?from\s+"[^"]+";/gm) ?? [];
    // Guard the guard: an extraction that matched NOTHING would also report no offenders.
    expect(statements.length).toBeGreaterThan(5);
    expect(statements.filter((s) => s.includes("startSampleInput"))).toEqual(
      [],
    );
  });
});

describe("setActive (workflow activation ↔ its ENV's schedules)", () => {
  it("DEACTIVATE pauses every schedule for the workflow IN THE ENV, THEN writes flag=false", async () => {
    findMany.mockResolvedValue([
      { id: "poll-t-1-e1-w" },
      { id: "cron-t-1-e1-w" },
    ]);
    const service = makeService(async () => null);

    await service.setActive("t-1", "e1", "w", false);

    // The row query + updates are env-scoped — sandbox toggles can't touch prod's schedules.
    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId: "t-1", environmentId: "e1", workflowKey: "w" },
      select: { id: true },
    });
    expect(pause).toHaveBeenCalledTimes(2); // both schedules paused
    expect(updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t-1", environmentId: "e1", workflowKey: "w" },
      data: { paused: true },
    });
    expect(setActiveFlag).toHaveBeenCalledWith("t-1", "e1", "w", false);
    // ordering: schedules paused before the flag flips (nothing fires against intent)
    expect(pause.mock.invocationCallOrder[0]).toBeLessThan(
      setActiveFlag.mock.invocationCallOrder[0],
    );
  });

  it("ACTIVATE writes flag=true FIRST, then unpauses the schedules", async () => {
    findMany.mockResolvedValue([{ id: "poll-t-1-e1-w" }]);
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
    findMany.mockResolvedValue([{ id: "poll-t-1-e1-w" }]);
    pause.mockRejectedValue(new Error("temporal unavailable"));
    describeHandle.mockResolvedValue({ state: { paused: false } }); // schedule still exists → real error
    const service = makeService(async () => null);

    await expect(service.setActive("t-1", "e1", "w", false)).rejects.toThrow(
      /temporal unavailable/,
    );
    expect(setActiveFlag).not.toHaveBeenCalled(); // flag stays active — fail-closed
  });

  it("DEACTIVATE tolerates a genuinely-missing schedule (describe also fails)", async () => {
    findMany.mockResolvedValue([{ id: "poll-t-1-e1-w" }]);
    pause.mockRejectedValue(new Error("not found"));
    describeHandle.mockRejectedValue(new Error("not found")); // schedule is gone → nothing to pause
    const service = makeService(async () => null);

    await service.setActive("t-1", "e1", "w", false); // does not throw
    expect(setActiveFlag).toHaveBeenCalledWith("t-1", "e1", "w", false);
  });

  it("NON-default env: pauses/resumes the CALLER'S env's schedules (gate removed)", async () => {
    // Schedules are env-scoped now — a sandbox toggle operates on sandbox's OWN Schedule rows
    // (queried by environmentId), so prod stays untouched by identity, not by a gate.
    findMany.mockResolvedValue([{ id: "poll-t-1-e-sandbox-w" }]);
    const service = makeService(async () => null);

    await service.setActive("t-1", "e-sandbox", "w", false);

    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId: "t-1", environmentId: "e-sandbox", workflowKey: "w" },
      select: { id: true },
    });
    expect(pause).toHaveBeenCalledOnce(); // sandbox's schedule IS paused now
    expect(updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t-1", environmentId: "e-sandbox", workflowKey: "w" },
      data: { paused: true },
    });
    expect(setActiveFlag).toHaveBeenCalledWith("t-1", "e-sandbox", "w", false);
  });
});

describe("teardownForWorkflow (per-env + legacy cleanup)", () => {
  it("deletes the env-scoped ids AND the orphan legacy no-env ids, then the env's rows", async () => {
    findMany.mockResolvedValue([{ id: "sched-t-1-e1-w-abcd1234" }]);
    findUnique.mockResolvedValue(null); // legacy ids have no registry row → orphan handles
    const service = makeService(async () => null);

    await service.teardownForWorkflow("t-1", "e1", "w");

    for (const id of [
      "poll-t-1-e1-w",
      "cron-t-1-e1-w",
      "poll-t-1-w", // legacy safety net
      "cron-t-1-w",
      "sched-t-1-e1-w-abcd1234", // user schedule row in this env
    ]) {
      expect(deletedIds).toContain(id);
    }
    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId: "t-1", environmentId: "e1", workflowKey: "w" },
      select: { id: true },
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { tenantId: "t-1", environmentId: "e1", workflowKey: "w" },
    });
  });

  it("a NON-owning env's teardown leaves another env's legacy schedule alone", async () => {
    findMany.mockResolvedValue([]);
    findUnique.mockResolvedValue({ environmentId: "e-prod" }); // legacy rows belong to prod
    const service = makeService(async () => null);

    await service.teardownForWorkflow("t-1", "e-sandbox", "w");

    // Sandbox's own env-scoped ids are deleted; prod's legacy ids survive.
    expect(deletedIds).toContain("poll-t-1-e-sandbox-w");
    expect(deletedIds).toContain("cron-t-1-e-sandbox-w");
    expect(deletedIds).not.toContain("poll-t-1-w");
    expect(deletedIds).not.toContain("cron-t-1-w");
  });
});

describe("setPaused / trigger respect activation (HIGH-1 + LOW)", () => {
  it("setPaused REFUSES to resume a schedule when the workflow is inactive IN ITS ENV (no re-arm)", async () => {
    findUnique.mockResolvedValue({
      tenantId: "t-1",
      environmentId: "e1",
      workflowKey: "w",
    });
    const isActive = vi.fn(async () => false);
    const service = makeService(async () => null, isActive);

    await expect(
      service.setPaused("t-1", "poll-t-1-e1-w", false),
    ).rejects.toThrow(/inactive/);
    expect(unpause).not.toHaveBeenCalled();
    // The activation check reads the SCHEDULE'S env — not a default-env fallback.
    expect(isActive).toHaveBeenCalledWith("t-1", "e1", "w");
  });

  it("setPaused still allows PAUSING (and resuming an active workflow)", async () => {
    findUnique.mockResolvedValue({
      tenantId: "t-1",
      environmentId: "e1",
      workflowKey: "w",
    });
    update.mockResolvedValue(undefined);
    const service = makeService(
      async () => null,
      async () => true,
    );

    await service.setPaused("t-1", "poll-t-1-e1-w", false); // active → allowed
    expect(unpause).toHaveBeenCalledOnce();
  });

  it("trigger is refused for an inactive workflow (checked in the schedule's env)", async () => {
    findUnique.mockResolvedValue({
      tenantId: "t-1",
      environmentId: "e1",
      workflowKey: "w",
    });
    const isActive = vi.fn(async () => false);
    const service = makeService(async () => null, isActive);

    await expect(service.trigger("t-1", "poll-t-1-e1-w")).rejects.toThrow(
      /inactive/,
    );
    expect(triggerNow).not.toHaveBeenCalled();
    expect(isActive).toHaveBeenCalledWith("t-1", "e1", "w");
  });
});
