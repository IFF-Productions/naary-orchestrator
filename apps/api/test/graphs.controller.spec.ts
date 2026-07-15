import "reflect-metadata";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { GraphDef } from "@naary/dsl";
import { describe, expect, it, vi } from "vitest";
import { SaveGraphDto } from "../src/graphs/graph.dto";
import { GraphsController } from "../src/graphs/graphs.controller";
import type { GraphGeneratorService } from "../src/graphs/graph-generator.service";
import type { GraphsService } from "../src/graphs/graphs.service";
import type { SchedulesService } from "../src/schedules/schedules.service";

// The save path calls schedules.syncPollSchedule(...) + syncCronSchedule(...).catch(...) —
// stubs that resolve are enough for the non-trigger graphs these tests use.
const schedulesStub = {
  syncPollSchedule: vi.fn().mockResolvedValue(undefined),
  syncCronSchedule: vi.fn().mockResolvedValue(undefined),
} as unknown as SchedulesService;

const envStub = {
  resolveEnvId: async () => "e1",
  defaultEnvId: async () => "e1",
  isDefaultEnv: async () => true,
} as never;

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
    const upsert = vi.fn().mockResolvedValue({
      graph: validGraph,
      version: 3,
      contentHash: "abc123",
    });
    const controller = new GraphsController(
      {
        upsert,
      } as unknown as GraphsService,
      {} as unknown as GraphGeneratorService,
      schedulesStub,
      envStub,
    );

    const res = await controller.save("t-1", dto(validGraph));

    expect(res).toEqual({
      workflowKey: "canvas",
      version: 3,
      contentHash: "abc123",
    });
    // tenantId comes from the principal (arg 0), never the body.
    expect(upsert).toHaveBeenCalledWith(
      "t-1",
      "e1",
      "canvas",
      "Canvas draft",
      validGraph,
    );
  });

  it("rejects a non-graph body with 400 (before touching the service)", async () => {
    const upsert = vi.fn();
    const controller = new GraphsController(
      {
        upsert,
      } as unknown as GraphsService,
      {} as unknown as GraphGeneratorService,
      schedulesStub,
      envStub,
    );

    await expect(
      controller.save("t-1", dto({ not: "a graph" })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("lists the tenant's workflows", async () => {
    const summaries = [
      {
        workflowKey: "canvas",
        name: "Canvas draft",
        version: 2,
        updatedAt: "t",
      },
    ];
    const list = vi.fn().mockResolvedValue(summaries);
    const controller = new GraphsController(
      {
        list,
      } as unknown as GraphsService,
      {} as unknown as GraphGeneratorService,
      schedulesStub,
      envStub,
    );

    expect(await controller.list("t-1")).toBe(summaries);
    expect(list).toHaveBeenCalledWith("t-1", "e1");
  });

  it("gets a single workflow's latest graph", async () => {
    const named = {
      workflowKey: "canvas",
      name: "Canvas draft",
      version: 2,
      graph: validGraph,
    };
    const getLatestNamed = vi.fn().mockResolvedValue(named);
    const controller = new GraphsController(
      {
        getLatestNamed,
      } as unknown as GraphsService,
      {} as unknown as GraphGeneratorService,
      schedulesStub,
      envStub,
    );

    expect(await controller.get("t-1", "canvas")).toBe(named);
    expect(getLatestNamed).toHaveBeenCalledWith("t-1", "e1", "canvas");
  });

  it("404s when the workflowKey is unknown", async () => {
    const getLatestNamed = vi.fn().mockResolvedValue(null);
    const controller = new GraphsController(
      {
        getLatestNamed,
      } as unknown as GraphsService,
      {} as unknown as GraphGeneratorService,
      schedulesStub,
      envStub,
    );

    await expect(controller.get("t-1", "nope")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
