import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphDef } from "@naary/dsl";

const findFirst = vi.fn();
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
    graphDefinition: { findFirst, create, deleteMany: del.graphDefinition },
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
  create.mockReset();
  $transaction.mockClear();
  for (const spy of Object.values(del)) spy.mockReset();
});

describe("GraphsService.upsert", () => {
  it("creates version 1 when no prior version exists", async () => {
    findFirst.mockResolvedValue(null);
    create.mockImplementation(async ({ data }) => ({ ...data }));

    const snap = await new GraphsService().upsert(
      "t1",
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
        new GraphsService().upsert("t1", "default", "Demo", bad),
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
      await new GraphsService().upsert("t1", "default", "D", withExtra);
      const persisted = create.mock.calls[0][0].data.graph as GraphDef;
      expect(persisted.nodes[1].config).toEqual({
        method: "GET",
        url: "https://x",
        _uiNote: "keep me",
      });
    });
  });
});

describe("GraphsService.deleteWorkflow", () => {
  it("returns false (→ controller 404) and touches nothing when no graph exists", async () => {
    findFirst.mockResolvedValue(null);

    const ok = await new GraphsService().deleteWorkflow("t1", "ghost");

    expect(ok).toBe(false);
    expect($transaction).not.toHaveBeenCalled();
    expect(del.graphDefinition).not.toHaveBeenCalled();
  });

  it("removes the graph + every dependent row in ONE transaction, keeping run history", async () => {
    findFirst.mockResolvedValue({ workflowKey: "wf-1" });

    const ok = await new GraphsService().deleteWorkflow("t1", "wf-1");

    expect(ok).toBe(true);
    // A single atomic transaction — not a series of loose deletes.
    expect($transaction).toHaveBeenCalledOnce();

    // Every table keyed by the workflow key is purged, scoped to the tenant.
    expect(del.graphDefinition).toHaveBeenCalledWith({
      where: { tenantId: "t1", workflowKey: "wf-1" },
    });
    expect(del.workflowActivation).toHaveBeenCalledWith({
      where: { tenantId: "t1", workflowKey: "wf-1" },
    });
    expect(del.pinnedData).toHaveBeenCalledWith({
      where: { tenantId: "t1", workflowKey: "wf-1" },
    });
    expect(del.pollState).toHaveBeenCalledWith({
      where: { tenantId: "t1", workflowKey: "wf-1" },
    });
    // Error-handler bindings are cleared whether this key is the FAILING flow or the HANDLER.
    expect(del.errorHandler).toHaveBeenCalledWith({
      where: {
        tenantId: "t1",
        OR: [{ workflowKey: "wf-1" }, { errorWorkflowKey: "wf-1" }],
      },
    });
    // Triggers reference the graph key as `workflowId` (not `workflowKey`).
    for (const trigger of [
      del.webhookEndpoint,
      del.formEndpoint,
      del.chatEndpoint,
    ]) {
      expect(trigger).toHaveBeenCalledWith({
        where: { tenantId: "t1", workflowId: "wf-1" },
      });
    }
  });
});
