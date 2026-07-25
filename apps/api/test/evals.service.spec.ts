// Workflow evals (#575) — the API surface: dataset write gate, run start (graph-version pinning),
// and the run/version linkage the promote comparison reads.
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphDef } from "@naary/dsl";

const datasetFindUnique = vi.fn();
const datasetUpsert = vi.fn();
const datasetFindMany = vi.fn();
const datasetDeleteMany = vi.fn();
const runCreate = vi.fn();
const runFindMany = vi.fn();
const runFindFirst = vi.fn();
vi.mock("@naary/db", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getPrisma: () => ({
    evalDataset: {
      findUnique: datasetFindUnique,
      upsert: datasetUpsert,
      findMany: datasetFindMany,
      deleteMany: datasetDeleteMany,
    },
    evalRun: {
      create: runCreate,
      findMany: runFindMany,
      findFirst: runFindFirst,
    },
  }),
}));

const getBudget = vi.fn();
vi.mock("@naary/usage", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getBudget: () => getBudget(),
}));

import { EvalsService, MAX_DATASET_BYTES } from "../src/evals/evals.service";
import type { GraphsService } from "../src/graphs/graphs.service";

const graph: GraphDef = {
  startNodeId: "a",
  nodes: [
    { id: "a", type: "start" },
    { id: "z", type: "end" },
  ],
  edges: [{ from: "a", to: "z" }],
};

const snapshot = { graph, contentHash: "hash-v7", version: 7 };
const graphs = {
  getLatest: () => Promise.resolve(snapshot),
} as unknown as GraphsService;

const start = vi.fn();

function service(): EvalsService {
  const s = new EvalsService(graphs);
  // The Temporal client is normally created in onModuleInit (a real connection); inject a stub.
  (s as unknown as { client: unknown }).client = {
    workflow: { start },
  };
  return s;
}

const DATASET = {
  assertions: [
    {
      kind: "jsonPathEquals",
      label: "cat",
      path: "agent.output.category",
      value: "billing",
    },
  ],
  cases: [
    { name: "double-charge", input: { message: "charged twice" } },
    { name: "upsell", input: { message: "more seats" } },
  ],
};

beforeEach(() => {
  for (const m of [
    datasetFindUnique,
    datasetUpsert,
    datasetFindMany,
    datasetDeleteMany,
    runCreate,
    runFindMany,
    runFindFirst,
    getBudget,
    start,
  ]) {
    m.mockReset();
  }
  getBudget.mockResolvedValue({ perExecutionCapUsd: 0.5, maxStepsPerRun: 100 });
  runCreate.mockResolvedValue({});
  start.mockResolvedValue({});
});

describe("saveDataset", () => {
  it("stores a valid dataset and reports its case/assertion counts", async () => {
    datasetUpsert.mockResolvedValue({
      id: "ds-1",
      name: "golden",
      updatedAt: new Date("2026-07-25T00:00:00Z"),
    });
    await expect(
      service().saveDataset("t1", "e1", "refunds", "golden", DATASET),
    ).resolves.toEqual({
      id: "ds-1",
      name: "golden",
      caseCount: 2,
      assertionCount: 1,
      updatedAt: "2026-07-25T00:00:00.000Z",
    });
    // Upserted by the (tenant, env, workflowKey, name) natural key — env-scoped like pins.
    expect(datasetUpsert.mock.calls[0][0].where).toEqual({
      tenantId_environmentId_workflowKey_name: {
        tenantId: "t1",
        environmentId: "e1",
        workflowKey: "refunds",
        name: "golden",
      },
    });
  });

  it("rejects an invalid dataset (400) and writes nothing", async () => {
    await expect(
      service().saveDataset("t1", "e1", "refunds", "golden", {
        cases: [
          { name: "dup", input: 1 },
          { name: "dup", input: 2 },
        ],
      }),
    ).rejects.toThrow(BadRequestException);
    expect(datasetUpsert).not.toHaveBeenCalled();
  });

  it("rejects a dataset larger than MAX_DATASET_BYTES (it rides one activity result)", async () => {
    const big = {
      cases: [{ name: "big", input: { blob: "x".repeat(MAX_DATASET_BYTES) } }],
    };
    await expect(
      service().saveDataset("t1", "e1", "refunds", "golden", big),
    ).rejects.toThrow(/too large/);
    expect(datasetUpsert).not.toHaveBeenCalled();
  });
});

describe("startRun", () => {
  beforeEach(() => {
    datasetFindUnique.mockResolvedValue({
      id: "ds-1",
      name: "golden",
      body: DATASET,
    });
  });

  it("pins the graph version + content hash on the row AND in the workflow args (#575 AC2)", async () => {
    const view = await service().startRun("t1", "e1", "refunds", "golden");
    expect(view).toMatchObject({
      graphVersion: 7,
      graphContentHash: "hash-v7",
      status: "running",
      totalCases: 2,
      passed: 0,
      failed: 0,
      errored: 0,
    });
    // The EvalRun row carries the linkage a promote screen compares on.
    const row = runCreate.mock.calls[0][0].data;
    expect(row).toMatchObject({
      tenantId: "t1",
      environmentId: "e1",
      workflowKey: "refunds",
      datasetId: "ds-1",
      graphVersion: 7,
      graphContentHash: "hash-v7",
      totalCases: 2,
    });
    // Row FIRST, then start: the workflow's first activity reads that row.
    expect(runCreate).toHaveBeenCalledBefore(start);

    const [wfName, opts] = start.mock.calls[0];
    expect(wfName).toBe("evalRun");
    expect(opts.workflowId).toBe(`eval-${row.id}`);
    expect(opts.args[0]).toMatchObject({
      tenantId: "t1",
      environmentId: "e1",
      workflowKey: "refunds",
      evalRunId: row.id,
      graphContentHash: "hash-v7",
      graphVersion: 7,
      // Each CASE gets its own per-run cap.
      perExecutionCapUsd: 0.5,
      maxStepsPerRun: 100,
    });
    expect(opts.args[0].graph).toEqual(graph);
    expect(opts.memo).toEqual({
      graphContentHash: "hash-v7",
      graphVersion: 7,
    });
  });

  it("404s on an unknown dataset and starts nothing", async () => {
    datasetFindUnique.mockResolvedValue(null);
    await expect(
      service().startRun("t1", "e1", "refunds", "nope"),
    ).rejects.toThrow(NotFoundException);
    expect(start).not.toHaveBeenCalled();
    expect(runCreate).not.toHaveBeenCalled();
  });

  it("400s on a dataset with no cases", async () => {
    datasetFindUnique.mockResolvedValue({
      id: "ds",
      name: "n",
      body: { cases: [] },
    });
    await expect(
      service().startRun("t1", "e1", "refunds", "golden"),
    ).rejects.toThrow(BadRequestException);
    expect(start).not.toHaveBeenCalled();
  });

  it("400s when the workflow has no saved graph in this environment", async () => {
    const s = new EvalsService({
      getLatest: () => Promise.resolve(null),
    } as unknown as GraphsService);
    (s as unknown as { client: unknown }).client = { workflow: { start } };
    await expect(s.startRun("t1", "e1", "refunds", "golden")).rejects.toThrow(
      /No saved graph/,
    );
  });
});

describe("listRuns / getRun", () => {
  const row = {
    id: "run-1",
    datasetId: "ds-1",
    dataset: { name: "golden" },
    workflowId: "eval-run-1",
    graphVersion: 7,
    graphContentHash: "hash-v7",
    status: "completed",
    totalCases: 20,
    passed: 18,
    failed: 2,
    errored: 0,
    costUsd: "0.420000",
    startedAt: new Date("2026-07-25T00:00:00Z"),
    finishedAt: new Date("2026-07-25T00:05:00Z"),
  };

  it("lists runs with the version linkage a promote screen compares on", async () => {
    runFindMany.mockResolvedValue([row]);
    const runs = await service().listRuns("t1", "e1", "refunds");
    expect(runs[0]).toEqual({
      id: "run-1",
      datasetId: "ds-1",
      datasetName: "golden",
      workflowId: "eval-run-1",
      graphVersion: 7,
      graphContentHash: "hash-v7",
      status: "completed",
      totalCases: 20,
      passed: 18,
      failed: 2,
      errored: 0,
      costUsd: 0.42,
      startedAt: "2026-07-25T00:00:00.000Z",
      finishedAt: "2026-07-25T00:05:00.000Z",
    });
    // "vN passed 18/20 vs vN-1 20/20" needs only what this row already carries.
    expect(runFindMany.mock.calls[0][0].orderBy).toEqual({ startedAt: "desc" });
  });

  it("clamps the limit", async () => {
    runFindMany.mockResolvedValue([]);
    await service().listRuns("t1", "e1", "refunds", 9999);
    expect(runFindMany.mock.calls[0][0].take).toBe(200);
  });

  it("getRun returns per-case verdicts with cost, and NO run output", async () => {
    runFindFirst.mockResolvedValue({
      ...row,
      workflowKey: "refunds",
      environmentId: "e1",
      results: [
        {
          caseName: "double-charge",
          executionId: "eval-run-1-case-0",
          verdict: "pass",
          score: "1.0000",
          costUsd: "0.010000",
          latencyMs: 900,
          assertions: [
            { label: "cat", kind: "jsonPathEquals", passed: true, score: 1 },
          ],
        },
      ],
    });
    const detail = await service().getRun("t1", "run-1");
    expect(detail.cases).toEqual([
      {
        caseName: "double-charge",
        executionId: "eval-run-1-case-0",
        verdict: "pass",
        score: 1,
        costUsd: 0.01,
        latencyMs: 900,
        assertions: [
          { label: "cat", kind: "jsonPathEquals", passed: true, score: 1 },
        ],
      },
    ]);
    // The projection has no field that could carry a payload or the judge's prose.
    expect(JSON.stringify(detail)).not.toContain("input");
    expect(JSON.stringify(detail)).not.toContain("reason");
    // Tenant-scoped lookup — an eval-run id alone is never enough.
    expect(runFindFirst.mock.calls[0][0].where).toEqual({
      id: "run-1",
      tenantId: "t1",
    });
  });

  it("getRun 404s on an unknown id", async () => {
    runFindFirst.mockResolvedValue(null);
    await expect(service().getRun("t1", "nope")).rejects.toThrow(
      NotFoundException,
    );
  });
});
