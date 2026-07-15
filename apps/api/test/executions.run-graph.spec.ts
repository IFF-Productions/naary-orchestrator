import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPayloadConverter } from "@temporalio/client";

// runGraph reads the Execution row (assertOwner) then decodes payloads[0] (the snapshot graph)
// from Temporal history — one findUnique mock + a fetchHistory stub serve both.
const findUnique = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ execution: { findUnique } }),
}));

import { ExecutionsService } from "../src/executions/executions.service";

function makeService(fetchHistory: unknown): ExecutionsService {
  const service = new ExecutionsService({} as never, { defaultEnvId: async () => "env-test", resolveEnvId: async () => "env-test" } as never);
  (service as unknown as { client: unknown }).client = {
    workflow: { getHandle: () => ({ fetchHistory }) },
  };
  return service;
}

// A WorkflowExecutionStarted event whose args are [graph, input, runCtx] — `startGraph`'s shape.
// `graph` is payloads[0].
function startedWithGraph(graph: unknown) {
  return {
    events: [
      {
        workflowExecutionStartedEventAttributes: {
          input: {
            payloads: [
              defaultPayloadConverter.toPayload(graph),
              defaultPayloadConverter.toPayload({ orderId: 1 }),
              defaultPayloadConverter.toPayload({ tenantId: "t-1" }),
            ],
          },
        },
      },
    ],
  };
}

const GRAPH = { nodes: [], edges: [], startNodeId: "s" };

beforeEach(() => findUnique.mockReset());

describe("runGraph (snapshot for the run-detail canvas)", () => {
  it("returns the snapshot graph decoded from history (payloads[0])", async () => {
    findUnique.mockResolvedValue({ workflowId: "wf", tenantId: "t-1" });
    const service = makeService(
      vi.fn().mockResolvedValue(startedWithGraph(GRAPH)),
    );

    const out = await service.runGraph("wf", "t-1");

    expect(out.graph).toEqual(GRAPH);
  });

  it("returns the version + workflowKey from the Execution read-model row", async () => {
    findUnique.mockResolvedValue({
      workflowId: "wf",
      tenantId: "t-1",
      graphVersion: 3,
      workflowKey: "refunds",
    });
    const service = makeService(
      vi.fn().mockResolvedValue(startedWithGraph(GRAPH)),
    );

    const out = await service.runGraph("wf", "t-1");

    expect(out.version).toBe(3);
    expect(out.workflowKey).toBe("refunds");
  });

  it("returns null version/workflowKey for a pre-migration row", async () => {
    findUnique.mockResolvedValue({ workflowId: "wf", tenantId: "t-1" });
    const service = makeService(
      vi.fn().mockResolvedValue(startedWithGraph(GRAPH)),
    );

    const out = await service.runGraph("wf", "t-1");

    expect(out.version).toBeNull();
    expect(out.workflowKey).toBeNull();
  });

  it("forbids a run owned by another tenant (no history read)", async () => {
    findUnique.mockResolvedValue({ workflowId: "wf", tenantId: "other" });
    const fetchHistory = vi.fn();
    const service = makeService(fetchHistory);

    await expect(service.runGraph("wf", "t-1")).rejects.toThrow(
      /another tenant/,
    );
    expect(fetchHistory).not.toHaveBeenCalled();
  });

  it("404s when the start event carries no payloads", async () => {
    findUnique.mockResolvedValue({ workflowId: "wf", tenantId: "t-1" });
    const service = makeService(
      vi.fn().mockResolvedValue({
        events: [
          {
            workflowExecutionStartedEventAttributes: {
              input: { payloads: [] },
            },
          },
        ],
      }),
    );

    await expect(service.runGraph("wf", "t-1")).rejects.toThrow(
      /no stored graph snapshot/,
    );
  });

  it("404s when payloads[0] decodes to a non-graph shape (array / missing nodes)", async () => {
    findUnique.mockResolvedValue({ workflowId: "wf", tenantId: "t-1" });
    // An array decodes fine but isn't a GraphDef — it must not reach the web decompiler.
    const service = makeService(
      vi.fn().mockResolvedValue(startedWithGraph([1, 2, 3])),
    );

    await expect(service.runGraph("wf", "t-1")).rejects.toThrow(
      /graph snapshot is unavailable/,
    );
  });
});
