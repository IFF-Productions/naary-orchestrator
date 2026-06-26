import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import type { GraphDef } from "@naary/dsl";
import { describe, expect, it, vi } from "vitest";
import { SaveGraphDto } from "../src/graphs/graph.dto";
import { GraphsController } from "../src/graphs/graphs.controller";
import type { GraphsService } from "../src/graphs/graphs.service";

const validGraph: GraphDef = {
  startNodeId: "start",
  nodes: [
    { id: "start", type: "start" },
    { id: "approval", type: "humanApproval" },
    { id: "end", type: "end" },
  ],
  edges: [
    { from: "start", to: "approval" },
    { from: "approval", to: "end" },
  ],
};

function dto(graph: unknown): SaveGraphDto {
  return Object.assign(new SaveGraphDto(), {
    workflowKey: "canvas",
    name: "Canvas draft",
    graph,
  });
}

describe("GraphsController", () => {
  it("saves a well-formed graph and returns the version + hash", async () => {
    const upsert = vi
      .fn()
      .mockResolvedValue({
        graph: validGraph,
        version: 3,
        contentHash: "abc123",
      });
    const controller = new GraphsController({
      upsert,
    } as unknown as GraphsService);

    const res = await controller.save("t-1", dto(validGraph));

    expect(res).toEqual({
      workflowKey: "canvas",
      version: 3,
      contentHash: "abc123",
    });
    // tenantId comes from the principal (arg 0), never the body.
    expect(upsert).toHaveBeenCalledWith(
      "t-1",
      "canvas",
      "Canvas draft",
      validGraph,
    );
  });

  it("rejects a non-graph body with 400 (before touching the service)", async () => {
    const upsert = vi.fn();
    const controller = new GraphsController({
      upsert,
    } as unknown as GraphsService);

    await expect(
      controller.save("t-1", dto({ not: "a graph" })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upsert).not.toHaveBeenCalled();
  });
});
