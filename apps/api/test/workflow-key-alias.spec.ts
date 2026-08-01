import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphDef } from "@naary/dsl";

/**
 * Workflow key rename via ALIAS (#904).
 *
 * The contract under test, in one line: everything WE own is rewritten to the new key, the old key
 * is retired but keeps RESOLVING, and the only path that refuses to resolve an alias is the one
 * that could mint a workflow (`upsert`).
 */

// --- the alias table --------------------------------------------------------------------------
// A tiny in-memory stand-in: `alias -> live key`, shared by the mocked `resolveWorkflowKey` and the
// mocked prisma. Real behaviour, no database.
const aliases = new Map<string, string>();

const aliasFindUnique = vi.fn(
  async ({ where }: { where: { tenantId_alias: { alias: string } } }) => {
    const to = aliases.get(where.tenantId_alias.alias);
    return to ? { workflowKey: to } : null;
  },
);
const aliasFindMany = vi.fn(
  async ({ where }: { where: { workflowKey: string } }) =>
    [...aliases.entries()]
      .filter(([, to]) => to === where.workflowKey)
      .map(([alias]) => ({ alias })),
);
const aliasCreate = vi.fn(
  async ({ data }: { data: { alias: string; workflowKey: string } }) => {
    if (aliases.has(data.alias))
      throw Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
      });
    aliases.set(data.alias, data.workflowKey);
    return data;
  },
);
const aliasUpdateMany = vi.fn(
  async ({
    where,
    data,
  }: {
    where: { workflowKey: string };
    data: { workflowKey: string };
  }) => {
    for (const [alias, to] of aliases)
      if (to === where.workflowKey) aliases.set(alias, data.workflowKey);
    return { count: 0 };
  },
);
const aliasDeleteMany = vi.fn(
  async ({ where }: { where: { workflowKey: string } }) => {
    for (const [alias, to] of [...aliases])
      if (to === where.workflowKey) aliases.delete(alias);
    return { count: 0 };
  },
);

// --- prisma -------------------------------------------------------------------------------------
const graphFindFirst = vi.fn();
const graphFindMany = vi.fn();
const graphFindUnique = vi.fn();
const graphCreate = vi.fn();
const graphUpdate = vi.fn();
const scheduleFindMany = vi.fn();
const activationFindMany = vi.fn();
const tagFindMany = vi.fn();

/** Every table the rename rewrites, as one `updateMany` spy each — so a test can assert that a
 *  surface actually FOLLOWS the workflow instead of being silently left behind. */
const MOVED = [
  "graphDefinition",
  "workflowActivation",
  "pinnedData",
  "pollState",
  "evalDataset",
  "evalRun",
  "selfHealSetting",
  "workflowFixProposal",
  "builderSession",
  "errorHandler",
  "execution",
  "promotion",
  "workflowTag",
  "workflowGrantKey",
  "webhookEndpoint",
  "formEndpoint",
  "chatEndpoint",
  "schedule",
] as const;
const moved: Record<string, ReturnType<typeof vi.fn>> = Object.fromEntries(
  MOVED.map((m) => [m, vi.fn(async () => ({ count: 1 }))]),
);
const scheduleDeleteMany = vi.fn(async () => ({ count: 0 }));

/** The definition rewrite MUTATES the in-memory rows, so everything after the transaction (the
 *  schedule re-sync, and the test's own post-rename reads) sees the world the real one would. */
moved.graphDefinition.mockImplementation(
  async ({
    where,
    data,
  }: {
    where: { workflowKey: string };
    data: { workflowKey: string };
  }) => {
    let count = 0;
    live = live.map((r) => {
      if (r.workflowKey !== where.workflowKey) return r;
      count++;
      return { ...r, workflowKey: data.workflowKey };
    });
    return { count };
  },
);

const grantFindMany = vi.fn(async () => [{ id: "grant-1" }]);

function tx() {
  const t: Record<string, unknown> = {
    workflowGrant: { findMany: grantFindMany },
    workflowKeyAlias: {
      create: aliasCreate,
      updateMany: aliasUpdateMany,
      findUnique: aliasFindUnique,
      findMany: aliasFindMany,
    },
  };
  for (const m of MOVED) t[m] = { updateMany: moved[m] };
  // graphDefinition is also READ inside the transaction (the in-transaction availability re-check).
  t.graphDefinition = {
    updateMany: moved.graphDefinition,
    findFirst: graphFindFirst,
  };
  t.schedule = { updateMany: moved.schedule, deleteMany: scheduleDeleteMany };
  return t;
}

const $transaction = vi.fn(async (arg: unknown) =>
  typeof arg === "function"
    ? await (arg as (t: unknown) => Promise<unknown>)(tx())
    : Promise.all(arg as unknown[]),
);

vi.mock("@naary/db", () => ({
  // The REAL resolver's semantics, backed by the in-memory alias map above.
  resolveWorkflowKey: async (_t: string, k: string) => aliases.get(k) ?? k,
  aliasesOf: async (_t: string, k: string) =>
    [...aliases.entries()].filter(([, to]) => to === k).map(([a]) => a),
  getPrisma: () => ({
    graphDefinition: {
      findFirst: graphFindFirst,
      findMany: graphFindMany,
      findUnique: graphFindUnique,
      create: graphCreate,
      update: graphUpdate,
      deleteMany: vi.fn(),
    },
    workflowKeyAlias: {
      findUnique: aliasFindUnique,
      findMany: aliasFindMany,
      create: aliasCreate,
      updateMany: aliasUpdateMany,
      deleteMany: aliasDeleteMany,
    },
    schedule: { findMany: scheduleFindMany, deleteMany: scheduleDeleteMany },
    workflowActivation: { findMany: activationFindMany },
    workflowTag: { findMany: tagFindMany },
    errorHandler: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    $transaction,
  }),
}));

import { GraphsService } from "../src/graphs/graphs.service";
import { WorkflowKeyRenameService } from "../src/graphs/workflow-key-rename.service";
import type { PermissionsService } from "../src/permissions/permissions.service";
import type { SchedulesService } from "../src/schedules/schedules.service";
import type { Principal } from "../src/auth/tenant.decorator";

const graph: GraphDef = {
  startNodeId: "a",
  nodes: [
    { id: "a", type: "start" },
    { id: "b", type: "end" },
  ],
  edges: [{ from: "a", to: "b" }],
};

const T = "t-1";
const OLD = "untitled-workflow";
const NEW = "invoice-sync";

function scheduleStub() {
  return {
    syncPollSchedule: vi.fn(async () => undefined),
    syncCronSchedule: vi.fn(async () => undefined),
    teardownForWorkflow: vi.fn(async () => undefined),
  };
}

/** GraphDefinition rows live here so the mocks can answer "which key exists?" honestly. */
let live: { workflowKey: string; environmentId: string; version: number }[] =
  [];

beforeEach(() => {
  aliases.clear();
  live = [{ workflowKey: OLD, environmentId: "env-prod", version: 3 }];
  for (const m of [
    aliasFindUnique,
    aliasFindMany,
    aliasCreate,
    aliasUpdateMany,
    aliasDeleteMany,
    graphFindMany,
    graphFindUnique,
    graphCreate,
    graphUpdate,
    scheduleFindMany,
    activationFindMany,
    tagFindMany,
    scheduleDeleteMany,
    $transaction,
  ])
    m.mockClear();
  for (const m of Object.values(moved)) m.mockClear();
  grantFindMany.mockClear();

  graphFindFirst.mockReset();
  graphFindFirst.mockImplementation(
    async ({ where }: { where: Record<string, unknown> }) => {
      const row = live.find(
        (r) =>
          r.workflowKey === where.workflowKey &&
          (where.environmentId === undefined ||
            typeof where.environmentId === "object" ||
            r.environmentId === where.environmentId),
      );
      return row
        ? { ...row, name: "Untitled", graph, contentHash: "h", id: "g1" }
        : null;
    },
  );
  graphFindMany.mockImplementation(
    async ({ where }: { where: Record<string, unknown> }) =>
      live.filter((r) => r.workflowKey === where.workflowKey),
  );
  scheduleFindMany.mockResolvedValue([]);
});

function renameService(
  schedules = scheduleStub(),
  perms?: Partial<PermissionsService>,
) {
  const graphs = new GraphsService();
  return {
    graphs,
    schedules,
    svc: new WorkflowKeyRenameService(
      graphs,
      schedules as unknown as SchedulesService,
      perms as PermissionsService | undefined,
    ),
  };
}

describe("#904 — renaming a workflow key", () => {
  it("moves the workflow to the new key and retires the old one as a resolving alias", async () => {
    const { svc } = renameService();
    const res = await svc.rename(T, OLD, NEW);

    expect(res).toMatchObject({ workflowKey: NEW, previousKey: OLD });
    expect(res.aliases).toEqual([OLD]);
    // The OLD key still resolves — that is the entire point of the alias.
    expect(await new GraphsService().liveKey(T, OLD)).toBe(NEW);
    // The NEW key resolves to itself (no chain, no self-alias row).
    expect(await new GraphsService().liveKey(T, NEW)).toBe(NEW);
  });

  it("rewrites EVERY table we own — the surfaces the issue enumerated follow the workflow", async () => {
    const { svc } = renameService();
    await svc.rename(T, OLD, NEW);
    // Run history, schedules, pins, tags, grants, evals, self-heal, promotions and the
    // webhook/form/chat trigger bindings all move. If any of these stops being rewritten, the
    // surface silently detaches from its workflow.
    for (const model of MOVED) {
      expect(moved[model], `${model} was not rewritten`).toHaveBeenCalled();
    }
    // ErrorHandler is rewritten in BOTH directions (this workflow's handler, and every workflow
    // that nominates this one as ITS handler).
    expect(moved.errorHandler).toHaveBeenCalledTimes(2);
    // The grant rewrite is scoped to THIS tenant's grant ids — a bare `workflowKey` filter would
    // reach into other tenants' grants (WorkflowGrantKey has no tenantId column).
    expect(grantFindMany).toHaveBeenCalledWith({
      where: { group: { tenantId: T } },
      select: { id: true },
    });
    expect(moved.workflowGrantKey.mock.calls[0][0].where).toMatchObject({
      grantId: { in: ["grant-1"] },
    });
  });

  it("an OLD key still resolves for reads after the rename (getLatestNamed hands back the LIVE key)", async () => {
    const { svc, graphs } = renameService();
    await svc.rename(T, OLD, NEW);

    const found = await graphs.getLatestNamed(T, "env-prod", OLD);
    expect(found).not.toBeNull();
    // Not the key that was asked for: the caller must adopt the live one, or its next save would be
    // refused by the alias guard on `upsert`.
    expect(found?.workflowKey).toBe(NEW);
    expect(await graphs.getLatest(T, "env-prod", NEW)).not.toBeNull();
  });

  it("REFUSES a save addressed at a retired key — a new workflow can never silently claim it", async () => {
    const { svc, graphs } = renameService();
    await svc.rename(T, OLD, NEW);
    graphCreate.mockClear();
    graphUpdate.mockClear();

    // Someone creates a fresh workflow whose derived key happens to be the retired one.
    const err = await graphs
      .upsert(T, "env-prod", OLD, "Untitled workflow", graph)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(JSON.stringify(err.getResponse())).toContain("WORKFLOW_KEY_RENAMED");
    expect(JSON.stringify(err.getResponse())).toContain(NEW);
    // And nothing was written: neither a new workflow nor a new version of the aliased one.
    expect(graphCreate).not.toHaveBeenCalled();
    expect(graphUpdate).not.toHaveBeenCalled();
  });

  it("rejects a new key that is already a LIVE workflow", async () => {
    live.push({ workflowKey: NEW, environmentId: "env-prod", version: 1 });
    const { svc } = renameService();
    await expect(svc.rename(T, OLD, NEW)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(aliases.size).toBe(0);
  });

  it("rejects a new key that is another workflow's RETIRED alias", async () => {
    // `legacy-flow` was renamed to `other-flow` at some point.
    aliases.set("legacy-flow", "other-flow");
    const { svc } = renameService();
    const err = await svc.rename(T, OLD, "legacy-flow").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toContain("other-flow");
    // Two workflows must never claim the same alias.
    expect(aliases.get("legacy-flow")).toBe("other-flow");
  });

  it("keeps aliases ONE HOP deep across a second rename", async () => {
    const { svc } = renameService();
    await svc.rename(T, OLD, NEW);
    const second = await svc.rename(T, NEW, "billing-sync");

    // Both retired keys now point DIRECTLY at the newest one — no chain to walk, so a single
    // indexed lookup is always enough and a cycle is unrepresentable.
    expect(aliases.get(OLD)).toBe("billing-sync");
    expect(aliases.get(NEW)).toBe("billing-sync");
    expect(second.aliases.sort()).toEqual([NEW, OLD].sort());
  });

  it("can be driven BY a retired key (an old bookmark or CLI script still renames the right flow)", async () => {
    const { svc } = renameService();
    await svc.rename(T, OLD, NEW);
    const res = await svc.rename(T, OLD, "billing-sync");
    expect(res.previousKey).toBe(NEW);
  });

  it("rejects a key that isn't a valid slug, and a no-op rename", async () => {
    const { svc } = renameService();
    await expect(svc.rename(T, OLD, "Not A Slug")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.rename(T, OLD, "-leading")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.rename(T, OLD, OLD)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect($transaction).not.toHaveBeenCalled();
  });

  it("404s for an unknown key, and never writes an alias for it", async () => {
    const { svc } = renameService();
    await expect(svc.rename(T, "no-such-flow", NEW)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(aliases.size).toBe(0);
  });

  describe("armed schedules keep firing", () => {
    it("creates the NEW derived handles BEFORE tearing down the old ones, and drops only the derived rows", async () => {
      scheduleFindMany.mockResolvedValue([
        { id: `poll-${T}-env-prod-${OLD}`, environmentId: "env-prod" },
        { id: `cron-${T}-env-prod-${OLD}`, environmentId: "env-prod" },
        {
          id: `sched-${T}-env-prod-${OLD}-abcd1234`,
          environmentId: "env-prod",
        },
      ]);
      const schedules = scheduleStub();
      const { svc } = renameService(schedules);

      const order: string[] = [];
      schedules.syncPollSchedule.mockImplementation(async () => {
        order.push("sync");
      });
      schedules.syncCronSchedule.mockImplementation(async () => {
        order.push("sync");
      });
      schedules.teardownForWorkflow.mockImplementation(async () => {
        order.push("teardown");
      });

      await svc.rename(T, OLD, NEW);

      // Ordering is the guarantee: a duplicate tick in the overlap is harmless (the old handle's
      // args resolve through the alias to the same workflow AND the same, rewritten, poll cursor),
      // whereas a GAP would silently skip a scheduled run.
      expect(order[0]).toBe("sync");
      expect(order[order.length - 1]).toBe("teardown");
      expect(schedules.syncPollSchedule).toHaveBeenCalledWith(
        T,
        "env-prod",
        NEW,
        expect.anything(),
      );
      // Teardown is addressed at the OLD key — that is what reconstructs `poll-…-<old>` /
      // `cron-…-<old>`, the handles nothing recomputes any more.
      expect(schedules.teardownForWorkflow).toHaveBeenCalledWith(
        T,
        "env-prod",
        OLD,
      );

      // Only the DERIVED rows are dropped (their id embeds the key, so they cannot be re-pointed).
      // A user-created `sched-` row keeps its id and its live Temporal handle, and is merely
      // re-pointed at the new key.
      expect(scheduleDeleteMany).toHaveBeenCalledWith({
        where: {
          tenantId: T,
          id: {
            in: [`poll-${T}-env-prod-${OLD}`, `cron-${T}-env-prod-${OLD}`],
          },
        },
      });
      expect(moved.schedule).toHaveBeenCalled();
    });

    it("a schedule that fires with the OLD key in its args still finds the workflow", async () => {
      const { svc, graphs } = renameService();
      await svc.rename(T, OLD, NEW);
      // This is exactly what SchedulesService's startWorkflow action does at fire time: it hands
      // the key from the (already-armed, unmodified) schedule args to the graph lookup.
      expect(await graphs.getLatest(T, "env-prod", OLD)).not.toBeNull();
    });
  });

  describe("in-flight runs", () => {
    it("a running graph is untouched: its snapshot is immutable and its key still resolves", async () => {
      const { svc, graphs } = renameService();
      await svc.rename(T, OLD, NEW);

      // A run pins its graph SNAPSHOT at start (graph versioning), so the interpreter re-reads
      // nothing by key. The only mid-run by-key lookups are sub-workflow / error-handler
      // resolution — and those resolve through the alias.
      expect(await graphs.liveKey(T, OLD)).toBe(NEW);
      expect(await graphs.getLatest(T, "env-prod", OLD)).not.toBeNull();
      // The run's own row was re-pointed, so it stays in the workflow's history rather than
      // stranding under a key the workflows list no longer shows.
      expect(moved.execution).toHaveBeenCalledWith({
        where: { tenantId: T, workflowKey: OLD },
        data: { workflowKey: NEW },
      });
    });
  });

  it("propagates a NON-constraint transaction failure instead of mislabelling it a collision", async () => {
    // The rewrite's own budget (or a dropped connection) must not surface as "pick a different
    // key" — that is the wrong diagnostic on exactly the failure this rewrite is most likely to hit.
    moved.execution.mockRejectedValueOnce(
      Object.assign(new Error("Transaction already closed"), { code: "P2028" }),
    );
    const { svc } = renameService();
    await expect(svc.rename(T, OLD, NEW)).rejects.toThrow(
      /Transaction already closed/,
    );
  });

  it("refuses to bind a workflow as its OWN error handler through a retired key", async () => {
    const { svc, graphs } = renameService();
    await svc.rename(T, OLD, NEW);

    // The controller's string comparison passes here (`new` !== `old`), but both keys resolve to
    // the SAME workflow — and a self-binding means a failing run spawns itself as its handler.
    await expect(
      graphs.setErrorHandler(T, "env-prod", NEW, OLD),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  describe("permissions (§4)", () => {
    it("asserts `edit` in EVERY environment the workflow exists in", async () => {
      live = [
        { workflowKey: OLD, environmentId: "env-sandbox", version: 1 },
        { workflowKey: OLD, environmentId: "env-prod", version: 4 },
      ];
      const assertCan = vi.fn(async () => undefined);
      const invalidateTenant = vi.fn();
      const { svc } = renameService(scheduleStub(), {
        assertCan,
        invalidateTenant,
      } as unknown as Partial<PermissionsService>);
      const actor = { userId: "u1", email: "a@b.c" } as Principal;

      await svc.rename(T, OLD, NEW, actor);

      expect(assertCan).toHaveBeenCalledTimes(2);
      expect(assertCan).toHaveBeenCalledWith(actor, "edit", OLD, "env-sandbox");
      expect(assertCan).toHaveBeenCalledWith(actor, "edit", OLD, "env-prod");
      // The cached scope='selected' key list still holds the OLD key — without this drop a
      // restricted member is 403'd on the NEW key for the cache's TTL.
      expect(invalidateTenant).toHaveBeenCalledWith(T);
    });

    it("a member without `edit` in one env cannot rename, and nothing is written", async () => {
      live = [
        { workflowKey: OLD, environmentId: "env-sandbox", version: 1 },
        { workflowKey: OLD, environmentId: "env-prod", version: 4 },
      ];
      const assertCan = vi.fn(async (_a, _v, _k, env: string) => {
        if (env === "env-prod") throw new ForbiddenException("nope");
      });
      const { svc } = renameService(scheduleStub(), {
        assertCan,
      } as unknown as Partial<PermissionsService>);
      await expect(
        svc.rename(T, OLD, NEW, { userId: "u1" } as Principal),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect($transaction).not.toHaveBeenCalled();
      expect(aliases.size).toBe(0);
    });

    it("fails CLOSED when an actor is passed but PermissionsService is unwired", async () => {
      const { svc } = renameService();
      await expect(
        svc.rename(T, OLD, NEW, { userId: "u1" } as Principal),
      ).rejects.toThrow(/PermissionsService is not wired/);
    });
  });
});
