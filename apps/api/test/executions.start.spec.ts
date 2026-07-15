import { beforeEach, describe, expect, it, vi } from "vitest";

// start() only reaches getPrisma inside startGraph, which we stub out below — so a
// minimal mock is enough (no query is actually issued in these tests).
vi.mock("@naary/db", () => ({ getPrisma: () => ({}) }));

import { ExecutionsService } from "../src/executions/executions.service";

const GRAPH = {
  startNodeId: "s",
  nodes: [{ id: "s", type: "start" }],
  edges: [],
};
const SNAP_LATEST = { graph: GRAPH, contentHash: "h-latest", version: 5 };
const SNAP_V2 = { graph: GRAPH, contentHash: "h-v2", version: 2 };

function makeService() {
  const service = new ExecutionsService(
    {} as never,
    {
      defaultEnvId: async () => "env-test",
      resolveEnvId: async () => "env-test",
    } as never,
  );
  const getLatest = vi.fn();
  const getVersion = vi.fn();
  (service as unknown as { graphs: unknown }).graphs = {
    getLatest,
    getVersion,
  };
  // Stub the private startGraph so we test ONLY the version-resolution branch (no
  // Temporal/budget/DB). Return the snapshot it was handed so we can assert which ran.
  const startGraph = vi
    .spyOn(
      service as unknown as {
        startGraph: (
          p: string,
          s: { version: number },
          ...rest: unknown[]
        ) => Promise<{ workflowId: string; version: number }>;
      },
      "startGraph",
    )
    .mockImplementation(async (_p, snap) => ({
      workflowId: "wf-new",
      version: (snap as { version: number }).version,
    }));
  return { service, getLatest, getVersion, startGraph };
}

describe("start (version resolution)", () => {
  it("uses the LATEST graph when no version is given", async () => {
    const { service, getLatest, getVersion } = makeService();
    getLatest.mockResolvedValue(SNAP_LATEST);

    const out = (await service.start(
      "t1",
      "e1",
      { x: 1 },
      "refunds",
    )) as unknown as {
      version: number;
    };

    expect(getLatest).toHaveBeenCalledWith("t1", "e1", "refunds");
    expect(getVersion).not.toHaveBeenCalled();
    expect(out.version).toBe(5); // startGraph got the latest snapshot
  });

  it("resolves the SPECIFIC version when graphVersion is given (not latest)", async () => {
    const { service, getLatest, getVersion } = makeService();
    getVersion.mockResolvedValue(SNAP_V2);

    const out = (await service.start(
      "t1",
      "e1",
      { x: 1 },
      "refunds",
      2,
    )) as unknown as { version: number };

    expect(getVersion).toHaveBeenCalledWith("t1", "e1", "refunds", 2);
    expect(getLatest).not.toHaveBeenCalled();
    expect(out.version).toBe(2); // startGraph got version 2's snapshot, not latest
  });

  it("404s with a version-specific message when the requested version is missing", async () => {
    const { service, getVersion } = makeService();
    getVersion.mockResolvedValue(null);

    await expect(
      service.start("t1", "e1", undefined, "refunds", 99),
    ).rejects.toThrow(/version 99 of 'refunds'/);
  });

  it("404s with the save-one-first message when no latest graph exists", async () => {
    const { service, getLatest } = makeService();
    getLatest.mockResolvedValue(null);

    await expect(
      service.start("t1", "e1", undefined, "refunds"),
    ).rejects.toThrow(/save one first/);
  });
});
