import { describe, expect, it, vi } from "vitest";

// startCodeAgentTest builds an in-memory graph and calls the private startGraph,
// which we stub — so no Temporal/budget/DB is touched (getPrisma is never reached).
vi.mock("@naary/db", () => ({ getPrisma: () => ({}) }));

import { ExecutionsService } from "../src/executions/executions.service";

type GraphArg = {
  startNodeId: string;
  nodes: { id: string; type: string; config?: Record<string, unknown> }[];
  edges: { from: string; to: string }[];
};

function makeService() {
  const service = new ExecutionsService({} as never, { defaultEnvId: async () => "env-test", resolveEnvId: async () => "env-test" } as never);
  // Capture the args startGraph is handed so we can assert the synthetic graph
  // shape + the system workflowKey without running the real start path.
  const startGraph = vi
    .spyOn(
      service as unknown as {
        startGraph: (...args: unknown[]) => Promise<{ workflowId: string }>;
      },
      "startGraph",
    )
    .mockResolvedValue({ workflowId: "catest-wf" });
  return { service, startGraph };
}

describe("startCodeAgentTest", () => {
  it("starts a read-only {start → codeAgent → end} run under the system workflowKey", async () => {
    const { service, startGraph } = makeService();

    const out = await service.startCodeAgentTest("t1");

    expect(out).toEqual({ workflowId: "catest-wf" });
    expect(startGraph).toHaveBeenCalledTimes(1);

    const [prefix, snapshot, input, tenantId, workflowKey] = startGraph.mock
      .calls[0] as [
      string,
      { graph: GraphArg; contentHash: string; version: number },
      unknown,
      string,
      string,
    ];

    expect(prefix).toBe("catest-t1");
    expect(input).toEqual({});
    expect(tenantId).toBe("t1");
    // System key — lets the Runs list / any filter recognise these test runs.
    expect(workflowKey).toBe("__codeagent_test");

    const { graph } = snapshot;
    expect(graph.startNodeId).toBe("start");
    expect(graph.nodes.map((n) => n.type)).toEqual([
      "start",
      "codeAgent",
      "end",
    ]);
    expect(graph.edges).toEqual([
      { from: "start", to: "codeAgent" },
      { from: "codeAgent", to: "end" },
    ]);

    // The codeAgent node runs the claude CLI, capped to one cheap turn.
    const codeAgent = graph.nodes.find((n) => n.id === "codeAgent");
    expect(codeAgent?.config?.tool).toBe("claude");
    expect(codeAgent?.config?.maxTurns).toBe(1);

    // A real content hash is snapshotted (version 0 = synthetic, not a saved graph).
    expect(snapshot.version).toBe(0);
    expect(typeof snapshot.contentHash).toBe("string");
    expect(snapshot.contentHash.length).toBeGreaterThan(0);
  });
});
