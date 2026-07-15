import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphDef } from "@naary/dsl";

const findFirst = vi.fn();
const findUnique = vi.fn();
const create = vi.fn();
const promotionCreate = vi.fn();
const promotionFindMany = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    graphDefinition: { findFirst, findUnique, create },
    promotion: { create: promotionCreate, findMany: promotionFindMany },
  }),
}));

import { GraphsService } from "../src/graphs/graphs.service";

const graph: GraphDef = {
  startNodeId: "a",
  nodes: [
    { id: "a", type: "start" },
    { id: "b", type: "end" },
  ],
  edges: [{ from: "a", to: "b" }],
};

beforeEach(() => {
  for (const m of [
    findFirst,
    findUnique,
    create,
    promotionCreate,
    promotionFindMany,
  ])
    m.mockReset();
});

describe("GraphsService.promote", () => {
  it("copies the source env's latest graph into the target env + records lineage", async () => {
    // 1st findFirst = source env's latest (v5); 2nd = target env's latest (none → v1 created).
    findFirst
      .mockResolvedValueOnce({
        name: "Refunds",
        graph,
        version: 5,
        contentHash: "h",
      })
      .mockResolvedValueOnce(null);
    create.mockImplementation(async ({ data }) => ({ ...data }));

    const out = await new GraphsService().promote(
      "t1",
      "refunds",
      "e-sandbox",
      "e-prod",
      "user-42",
    );

    expect(out).toEqual({
      fromVersion: 5,
      toVersion: 1,
      contentHash: expect.any(String),
    });
    // Written into the TARGET env.
    expect(create.mock.calls[0][0].data.environmentId).toBe("e-prod");
    expect(create.mock.calls[0][0].data.name).toBe("Refunds");
    // Lineage recorded.
    expect(promotionCreate).toHaveBeenCalledWith({
      data: {
        tenantId: "t1",
        workflowKey: "refunds",
        fromEnvId: "e-sandbox",
        toEnvId: "e-prod",
        fromVersion: 5,
        toVersion: 1,
        actor: "user-42",
      },
    });
  });

  it("promotes a CHOSEN version (findUnique on the composite key)", async () => {
    findUnique.mockResolvedValue({
      name: "Refunds",
      graph,
      version: 3,
      contentHash: "h",
    });
    findFirst.mockResolvedValueOnce(null); // target latest (inside upsert)
    create.mockImplementation(async ({ data }) => ({ ...data }));

    const out = await new GraphsService().promote(
      "t1",
      "refunds",
      "e-sandbox",
      "e-prod",
      "user-42",
      3,
    );

    expect(findUnique.mock.calls[0][0].where).toEqual({
      tenantId_environmentId_workflowKey_version: {
        tenantId: "t1",
        environmentId: "e-sandbox",
        workflowKey: "refunds",
        version: 3,
      },
    });
    expect(out.fromVersion).toBe(3);
  });

  it("rejects promoting an env to itself", async () => {
    await expect(
      new GraphsService().promote("t1", "wf", "e1", "e1", "u"),
    ).rejects.toThrow(/must differ/);
    expect(create).not.toHaveBeenCalled();
  });

  it("404s when the source graph doesn't exist", async () => {
    findFirst.mockResolvedValue(null);
    await expect(
      new GraphsService().promote("t1", "ghost", "e-sandbox", "e-prod", "u"),
    ).rejects.toThrow(/No 'ghost' graph in the source/);
    expect(promotionCreate).not.toHaveBeenCalled();
  });
});
