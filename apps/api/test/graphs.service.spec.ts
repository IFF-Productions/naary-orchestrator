import { BadRequestException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphDef } from "@naary/dsl";

const findFirst = vi.fn();
const findUnique = vi.fn();
const findMany = vi.fn();
const create = vi.fn();
// deleteWorkflow fans a $transaction across every table that points at a workflow key.
// Each model's deleteMany is a spy so we can assert WHAT got deleted (and that nothing
// touches the Execution history). $transaction just runs the array of prisma promises.
const del = {
  graphDefinition: vi.fn(),
  workflowActivation: vi.fn(),
  pinnedData: vi.fn(),
  pollState: vi.fn(),
  errorHandler: vi.fn(),
  webhookEndpoint: vi.fn(),
  formEndpoint: vi.fn(),
  chatEndpoint: vi.fn(),
};
const $transaction = vi.fn(async (ops: unknown[]) => Promise.all(ops));
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    graphDefinition: {
      findFirst,
      findUnique,
      findMany,
      create,
      deleteMany: del.graphDefinition,
    },
    workflowActivation: { deleteMany: del.workflowActivation },
    pinnedData: { deleteMany: del.pinnedData },
    pollState: { deleteMany: del.pollState },
    errorHandler: { deleteMany: del.errorHandler },
    webhookEndpoint: { deleteMany: del.webhookEndpoint },
    formEndpoint: { deleteMany: del.formEndpoint },
    chatEndpoint: { deleteMany: del.chatEndpoint },
    $transaction,
    // Deliberately NO `execution` model: if deleteWorkflow ever tried to purge run
    // history, the mock would throw here — the test would catch the regression.
  }),
}));

import { GraphsService, hashGraph } from "../src/graphs/graphs.service";

const graph: GraphDef = {
  startNodeId: "a",
  nodes: [
    { id: "a", type: "start" },
    { id: "b", type: "end" },
  ],
  edges: [{ from: "a", to: "b" }],
};

beforeEach(() => {
  findFirst.mockReset();
  findUnique.mockReset();
  findMany.mockReset();
  create.mockReset();
  $transaction.mockClear();
  for (const spy of Object.values(del)) spy.mockReset();
});

describe("GraphsService.connectionUsageCounts (#471)", () => {
  it("counts refs across node types + latest-version-only + env-scoped where", async () => {
    // version desc, as the query orders. Two rows share workflowKey "refunds" → only the
    // latest (v2) counts; the stale v1 (which references conn-A) must be ignored.
    findMany.mockResolvedValue([
      {
        workflowKey: "refunds",
        graph: {
          nodes: [
            {
              id: "n1",
              type: "httpRequest",
              config: { connectionId: "conn-A" },
            },
            {
              id: "n2",
              type: "integration",
              config: { connectionId: "conn-A", provider: "github" },
            },
            { id: "n3", type: "sqlQuery", config: { connectionId: "conn-B" } },
            { id: "n4", type: "set", config: { value: 1 } }, // no connectionId
          ],
        },
      },
      {
        workflowKey: "onboard",
        graph: {
          nodes: [
            { id: "m1", type: "mcpTool", config: { connectionId: "conn-B" } },
          ],
        },
      },
      // STALE older version of "refunds" — references conn-C; must NOT count.
      {
        workflowKey: "refunds",
        graph: {
          nodes: [
            {
              id: "old",
              type: "httpRequest",
              config: { connectionId: "conn-C" },
            },
          ],
        },
      },
    ]);

    const counts = await new GraphsService().connectionUsageCounts(
      "t1",
      "e-prod",
    );

    // conn-A: 2 nodes in refunds-v2; conn-B: 1 (refunds) + 1 (onboard); conn-C: 0 (stale only).
    expect(counts).toEqual({ "conn-A": 2, "conn-B": 2 });
    // Env-scoped: the query filters by BOTH tenant and env (prod must not count sandbox).
    expect(findMany.mock.calls[0][0].where).toEqual({
      tenantId: "t1",
      environmentId: "e-prod",
    });
  });

  it("returns an empty map (every connection reads as 0) when there are no graphs", async () => {
    findMany.mockResolvedValue([]);
    expect(await new GraphsService().connectionUsageCounts("t1", "e1")).toEqual(
      {},
    );
  });
});

describe("GraphsService.upsert", () => {
  it("creates version 1 when no prior version exists", async () => {
    findFirst.mockResolvedValue(null);
    create.mockImplementation(async ({ data }) => ({ ...data }));

    const snap = await new GraphsService().upsert(
      "t1",
      "e1",
      "default",
      "Demo",
      graph,
    );

    expect(snap.version).toBe(1);
    expect(snap.contentHash).toBe(hashGraph(graph));
    expect(create.mock.calls[0][0].data).toMatchObject({
      tenantId: "t1",
      workflowKey: "default",
      version: 1,
    });
  });

  it("is a no-op (same version) when the content hash is unchanged", async () => {
    findFirst.mockResolvedValue({
      graph,
      contentHash: hashGraph(graph),
      version: 3,
    });

    const snap = await new GraphsService().upsert(
      "t1",
      "e1",
      "default",
      "Demo",
      graph,
    );

    expect(snap.version).toBe(3);
    expect(create).not.toHaveBeenCalled();
  });

  it("bumps the version + records a new hash when the graph changes", async () => {
    findFirst.mockResolvedValue({
      graph,
      contentHash: "stale-different-hash",
      version: 3,
    });
    create.mockImplementation(async ({ data }) => ({ ...data }));

    const changed: GraphDef = {
      ...graph,
      nodes: [...graph.nodes, { id: "c", type: "agent" }],
    };
    const snap = await new GraphsService().upsert(
      "t1",
      "e1",
      "default",
      "Demo",
      changed,
    );

    expect(snap.version).toBe(4);
    expect(snap.contentHash).toBe(hashGraph(changed));
    expect(snap.contentHash).not.toBe(hashGraph(graph));
  });

  describe("config gate (Phase 3)", () => {
    it("rejects a node whose PRESENT config value is the wrong type", async () => {
      findFirst.mockResolvedValue(null);
      const bad: GraphDef = {
        startNodeId: "a",
        nodes: [
          { id: "a", type: "start" },
          // method must be an HTTP verb, url a string — both wrong here
          {
            id: "h",
            type: "httpRequest",
            config: { method: "FETCH", url: 42 } as Record<string, unknown>,
          },
        ],
        edges: [{ from: "a", to: "h" }],
      };
      await expect(
        new GraphsService().upsert("t1", "e1", "default", "Demo", bad),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(create).not.toHaveBeenCalled();
    });

    it("ALLOWS an in-progress draft with required fields still unfilled", async () => {
      findFirst.mockResolvedValue(null);
      create.mockImplementation(async ({ data }) => ({ ...data }));
      const draft: GraphDef = {
        startNodeId: "a",
        nodes: [
          { id: "a", type: "start" },
          { id: "h", type: "httpRequest", config: { method: "GET" } }, // no url yet
        ],
        edges: [{ from: "a", to: "h" }],
      };
      const snap = await new GraphsService().upsert(
        "t1",
        "e1",
        "default",
        "D",
        draft,
      );
      expect(snap.version).toBe(1);
    });

    it("persists the ORIGINAL config bytes (gate does not strip unmodeled keys)", async () => {
      findFirst.mockResolvedValue(null);
      create.mockImplementation(async ({ data }) => ({ ...data }));
      const withExtra: GraphDef = {
        startNodeId: "a",
        nodes: [
          { id: "a", type: "start" },
          {
            id: "h",
            type: "httpRequest",
            config: { method: "GET", url: "https://x", _uiNote: "keep me" },
          },
        ],
        edges: [{ from: "a", to: "h" }],
      };
      await new GraphsService().upsert("t1", "e1", "default", "D", withExtra);
      const persisted = create.mock.calls[0][0].data.graph as GraphDef;
      expect(persisted.nodes[1].config).toEqual({
        method: "GET",
        url: "https://x",
        _uiNote: "keep me",
      });
    });
  });
});

describe("GraphsService.getVersion", () => {
  it("returns a specific version's snapshot, scoped to (tenant, key, version)", async () => {
    findUnique.mockResolvedValue({
      graph,
      contentHash: hashGraph(graph),
      version: 2,
    });

    const snap = await new GraphsService().getVersion("t1", "e1", "refunds", 2);

    expect(snap?.version).toBe(2);
    expect(snap?.contentHash).toBe(hashGraph(graph));
    // Composite-unique lookup — never resolves another tenant's or key's row.
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        tenantId_environmentId_workflowKey_version: {
          tenantId: "t1",
          environmentId: "e1",
          workflowKey: "refunds",
          version: 2,
        },
      },
    });
  });

  it("returns null when that (key, version) doesn't exist (→ 404 at the caller)", async () => {
    findUnique.mockResolvedValue(null);
    const snap = await new GraphsService().getVersion(
      "t1",
      "e1",
      "refunds",
      99,
    );
    expect(snap).toBeNull();
  });
});

describe("GraphsService.listVersions", () => {
  it("lists every version newest-first, identity only (no graph bodies)", async () => {
    const now = new Date("2026-07-13T00:00:00.000Z");
    findMany.mockResolvedValue([
      { version: 3, contentHash: "h3", createdAt: now },
      { version: 2, contentHash: "h2", createdAt: now },
      { version: 1, contentHash: "h1", createdAt: now },
    ]);

    const out = await new GraphsService().listVersions("t1", "e1", "refunds");

    expect(out.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(out[0]).toEqual({
      version: 3,
      contentHash: "h3",
      createdAt: now.toISOString(),
    });
    const arg = findMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      tenantId: "t1",
      environmentId: "e1",
      workflowKey: "refunds",
    });
    expect(arg.orderBy).toEqual({ version: "desc" });
    // No graph body selected — the picker only needs identity.
    expect(arg.select).not.toHaveProperty("graph");
  });
});

describe("GraphsService.deleteWorkflow", () => {
  it("returns false (→ controller 404) and touches nothing when no graph exists", async () => {
    findFirst.mockResolvedValue(null);

    const ok = await new GraphsService().deleteWorkflow("t1", "e1", "ghost");

    expect(ok).toBe(false);
    expect($transaction).not.toHaveBeenCalled();
    expect(del.graphDefinition).not.toHaveBeenCalled();
  });

  it("removes the graph + every dependent row in ONE transaction, keeping run history", async () => {
    findFirst.mockResolvedValue({ workflowKey: "wf-1" });

    const ok = await new GraphsService().deleteWorkflow("t1", "e1", "wf-1");

    expect(ok).toBe(true);
    // A single atomic transaction — not a series of loose deletes.
    expect($transaction).toHaveBeenCalledOnce();

    // Everything env-scoped is purged for THIS env.
    expect(del.graphDefinition).toHaveBeenCalledWith({
      where: { tenantId: "t1", environmentId: "e1", workflowKey: "wf-1" },
    });
    expect(del.workflowActivation).toHaveBeenCalledWith({
      where: { tenantId: "t1", environmentId: "e1", workflowKey: "wf-1" },
    });
    // Pins are env-scoped (6b): deleted for THIS env alongside the graph.
    expect(del.pinnedData).toHaveBeenCalledWith({
      where: { tenantId: "t1", environmentId: "e1", workflowKey: "wf-1" },
    });
    // PollState is env-scoped now (env-scoped-schedules slice) — always deleted for THIS env.
    expect(del.pollState).toHaveBeenCalledWith({
      where: { tenantId: "t1", environmentId: "e1", workflowKey: "wf-1" },
    });
    // Error-handler bindings (env-scoped, slice-6 cleanup) are cleared whether this key is
    // the FAILING flow or the HANDLER — but only in THIS env.
    expect(del.errorHandler).toHaveBeenCalledWith({
      where: {
        tenantId: "t1",
        environmentId: "e1",
        OR: [{ workflowKey: "wf-1" }, { errorWorkflowKey: "wf-1" }],
      },
    });
    // Triggers reference the graph key as `workflowId` (not `workflowKey`) and are env-scoped.
    for (const trigger of [
      del.webhookEndpoint,
      del.formEndpoint,
      del.chatEndpoint,
    ]) {
      expect(trigger).toHaveBeenCalledWith({
        where: { tenantId: "t1", environmentId: "e1", workflowId: "wf-1" },
      });
    }
  });

  it("NON-default env: removes THIS env's rows only (incl. its poll cursor)", async () => {
    findFirst.mockResolvedValue({ workflowKey: "wf-1" });

    const ok = await new GraphsService().deleteWorkflow(
      "t1",
      "e-sandbox",
      "wf-1",
    );

    expect(ok).toBe(true);
    const sandboxScoped = {
      tenantId: "t1",
      environmentId: "e-sandbox",
      workflowKey: "wf-1",
    };
    // The env's definition + activation + pins are removed…
    expect(del.graphDefinition).toHaveBeenCalledWith({ where: sandboxScoped });
    expect(del.workflowActivation).toHaveBeenCalledOnce();
    expect(del.pinnedData).toHaveBeenCalledWith({ where: sandboxScoped });
    // …and (slice-6 cleanup) so are the env's error-handler bindings + trigger endpoints —
    // scoped to e-sandbox, so prod's copies of the same key survive.
    expect(del.errorHandler).toHaveBeenCalledWith({
      where: {
        tenantId: "t1",
        environmentId: "e-sandbox",
        OR: [{ workflowKey: "wf-1" }, { errorWorkflowKey: "wf-1" }],
      },
    });
    for (const trigger of [
      del.webhookEndpoint,
      del.formEndpoint,
      del.chatEndpoint,
    ]) {
      expect(trigger).toHaveBeenCalledWith({
        where: {
          tenantId: "t1",
          environmentId: "e-sandbox",
          workflowId: "wf-1",
        },
      });
    }
    // The env's OWN poll cursor goes with it — scoped, so prod's cursor survives.
    expect(del.pollState).toHaveBeenCalledWith({ where: sandboxScoped });
  });
});

describe("diffVersions", () => {
  const row = (v: number, g: GraphDef) => ({
    graph: g,
    contentHash: `h${v}`,
    version: v,
  });
  const v1: GraphDef = {
    startNodeId: "a",
    nodes: [
      { id: "a", type: "start" },
      { id: "b", type: "agent", config: { model: "m1" } },
    ],
    edges: [{ from: "a", to: "b" }],
  };
  const v2: GraphDef = {
    startNodeId: "a",
    nodes: [
      { id: "a", type: "start" },
      { id: "b", type: "agent", config: { model: "m2" } },
      { id: "c", type: "end" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
  };

  it("returns the structural diff between two versions", async () => {
    findUnique
      .mockResolvedValueOnce(row(1, v1))
      .mockResolvedValueOnce(row(2, v2));
    const d = await new GraphsService().diffVersions(
      "t1",
      "e1",
      "refunds",
      1,
      2,
    );
    expect(d.fromVersion).toBe(1);
    expect(d.toVersion).toBe(2);
    expect(d.nodesAdded.map((n) => n.id)).toEqual(["c"]);
    expect(d.nodesChanged.map((n) => n.id)).toEqual(["b"]);
    expect(d.nodesChanged[0].fields).toEqual(["config"]);
  });

  it("404s when a version is missing", async () => {
    findUnique.mockResolvedValueOnce(row(1, v1)).mockResolvedValueOnce(null);
    await expect(
      new GraphsService().diffVersions("t1", "e1", "refunds", 1, 9),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ---------------------------------------------------------------------------
// RBAC G1 (RBAC-GROUPS.md §4): in-service permission gates. The service asserts
// through PermissionsService ONLY when an actor is passed — internal/trigger
// callers (no actor) are byte-identical to before (migration neutrality).
// ---------------------------------------------------------------------------
import { ForbiddenException } from "@nestjs/common";
import type { Principal } from "../src/auth/tenant.decorator";
import type { PermissionsService } from "../src/permissions/permissions.service";

describe("GraphsService G1 permission gates", () => {
  const member: Principal = { tenantId: "t1", userId: "u-1", role: "member" };
  const deny = () => Promise.reject(new ForbiddenException("no"));
  const allow = () => Promise.resolve();

  function withPerms(perms: Partial<Record<string, unknown>>): GraphsService {
    return new GraphsService(perms as unknown as PermissionsService);
  }

  it("upsert of an EXISTING key asserts `edit` (and a denial persists nothing)", async () => {
    const assertCan = vi.fn().mockImplementation(deny);
    const svc = withPerms({ assertCan });
    findFirst.mockResolvedValue({
      version: 1,
      contentHash: "other",
      graph,
    });
    await expect(
      svc.upsert("t1", "e1", "wf", "WF", graph, member),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(assertCan).toHaveBeenCalledWith(member, "edit", "wf", "e1");
    expect(create).not.toHaveBeenCalled();
  });

  it("upsert of a NEW key asserts canCreate (its own verb — never edit)", async () => {
    const assertCan = vi.fn().mockImplementation(allow);
    const assertCanCreate = vi.fn().mockImplementation(deny);
    const svc = withPerms({ assertCan, assertCanCreate });
    findFirst.mockResolvedValue(null); // no prior version = a CREATE
    await expect(
      svc.upsert("t1", "e1", "brand-new", "New", graph, member),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(assertCanCreate).toHaveBeenCalledWith(member, "e1");
    expect(assertCan).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("a GRANTED member's save goes through", async () => {
    const assertCan = vi.fn().mockImplementation(allow);
    const svc = withPerms({ assertCan });
    findFirst.mockResolvedValue({ version: 1, contentHash: "old", graph });
    create.mockImplementation(async ({ data }) => ({ ...data }));
    const snap = await svc.upsert("t1", "e1", "wf", "WF", graph, member);
    expect(snap.version).toBe(2);
    expect(assertCan).toHaveBeenCalledWith(member, "edit", "wf", "e1");
  });

  it("upsert with NO actor never consults permissions (trigger/internal path unchanged)", async () => {
    const assertCan = vi.fn();
    const assertCanCreate = vi.fn();
    const svc = withPerms({ assertCan, assertCanCreate });
    findFirst.mockResolvedValue(null);
    create.mockImplementation(async ({ data }) => ({ ...data }));
    await svc.upsert("t1", "e1", "wf", "WF", graph);
    expect(assertCan).not.toHaveBeenCalled();
    expect(assertCanCreate).not.toHaveBeenCalled();
  });

  it("getLatestNamed asserts `view` BEFORE the read (403, no existence oracle)", async () => {
    const assertCan = vi.fn().mockImplementation(deny);
    const svc = withPerms({ assertCan });
    await expect(
      svc.getLatestNamed("t1", "e1", "wf", member),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(assertCan).toHaveBeenCalledWith(member, "view", "wf", "e1");
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("listVersions + diffVersions assert `view`", async () => {
    const assertCan = vi.fn().mockImplementation(deny);
    const svc = withPerms({ assertCan });
    await expect(
      svc.listVersions("t1", "e1", "wf", member),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      svc.diffVersions("t1", "e1", "wf", 1, 2, member),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(assertCan).toHaveBeenNthCalledWith(1, member, "view", "wf", "e1");
    expect(assertCan).toHaveBeenNthCalledWith(2, member, "view", "wf", "e1");
  });

  it("promote asserts `share` against the SOURCE env (§8.2) before reading anything", async () => {
    const assertCan = vi.fn().mockImplementation(deny);
    const svc = withPerms({ assertCan });
    await expect(
      svc.promote("t1", "wf", "e-src", "e-dst", "u-1", undefined, member),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(assertCan).toHaveBeenCalledWith(member, "share", "wf", "e-src");
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("an actor WITHOUT wired permissions fails CLOSED (never silently skips authz)", async () => {
    const svc = new GraphsService(); // no PermissionsService — a wiring bug
    await expect(svc.getLatestNamed("t1", "e1", "wf", member)).rejects.toThrow(
      /PermissionsService is not wired/,
    );
  });
});
