import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphDef } from "@naary/dsl";

const findFirst = vi.fn();
const create = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ graphDefinition: { findFirst, create } }),
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
