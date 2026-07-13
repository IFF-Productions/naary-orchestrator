import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPayloadConverter } from "@temporalio/client";

// executions.service imports only getPrisma from @naary/db. Both assertOwner and
// rerun read the Execution row via execution.findUnique — one mock serves both.
const findUnique = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ execution: { findUnique } }),
}));

import { ExecutionsService } from "../src/executions/executions.service";

function makeService(fetchHistory: unknown): ExecutionsService {
  const service = new ExecutionsService({} as never);
  (service as unknown as { client: unknown }).client = {
    workflow: { getHandle: () => ({ fetchHistory }) },
  };
  return service;
}

// A history whose WorkflowExecutionStarted event carries the workflow's start args
// [graph, input, runCtx] — the interpreter's `startGraph` shape. `input` is payloads[1].
function startedWith(input: unknown) {
  return {
    events: [
      {
        workflowExecutionStartedEventAttributes: {
          input: {
            payloads: [
              defaultPayloadConverter.toPayload({
                nodes: [],
                edges: [],
                startNodeId: "s",
              }),
              defaultPayloadConverter.toPayload(input),
              defaultPayloadConverter.toPayload({ tenantId: "t-1" }),
            ],
          },
        },
      },
      { activityTaskScheduledEventAttributes: {} },
    ],
  };
}

beforeEach(() => findUnique.mockReset());

describe("rerun", () => {
  it("re-runs with the ORIGINAL trigger input against the same workflowKey", async () => {
    findUnique.mockResolvedValue({
      workflowId: "wf-old",
      tenantId: "t-1",
      workflowKey: "refunds",
    });
    const service = makeService(
      vi.fn().mockResolvedValue(startedWith({ orderId: 42 })),
    );
    const start = vi
      .spyOn(service, "start")
      .mockResolvedValue({ workflowId: "wf-new" });

    const out = await service.rerun("wf-old", "t-1");

    expect(out).toEqual({ workflowId: "wf-new" });
    // input read from history (not ctx) → works even for a FAILED original run.
    expect(start).toHaveBeenCalledWith("t-1", { orderId: 42 }, "refunds");
  });

  it("falls back to default input when the start payload is missing/undecodable", async () => {
    findUnique.mockResolvedValue({
      workflowId: "wf-old",
      tenantId: "t-1",
      workflowKey: "wk",
    });
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
    const start = vi
      .spyOn(service, "start")
      .mockResolvedValue({ workflowId: "wf-new" });

    await service.rerun("wf-old", "t-1");

    expect(start).toHaveBeenCalledWith("t-1", undefined, "wk");
  });

  it("rejects a run that predates workflow-key tracking (400, no start)", async () => {
    findUnique.mockResolvedValue({
      workflowId: "wf-old",
      tenantId: "t-1",
      workflowKey: null,
    });
    const service = makeService(vi.fn());
    const start = vi.spyOn(service, "start");

    await expect(service.rerun("wf-old", "t-1")).rejects.toThrow(
      /can't be re-run/,
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("forbids re-running a run owned by another tenant", async () => {
    findUnique.mockResolvedValue({
      workflowId: "wf-old",
      tenantId: "other-tenant",
      workflowKey: "wk",
    });
    const service = makeService(vi.fn());

    await expect(service.rerun("wf-old", "t-1")).rejects.toThrow(
      /another tenant/,
    );
  });
});

describe("runGraph (snapshot for the run-detail canvas)", () => {
  it("returns the snapshot graph decoded from history (payloads[0])", async () => {
    findUnique.mockResolvedValue({ workflowId: "wf", tenantId: "t-1" });
    const service = makeService(
      vi.fn().mockResolvedValue(startedWith({ orderId: 1 })),
    );

    const out = await service.runGraph("wf", "t-1");

    // startedWith puts this graph at payloads[0].
    expect(out.graph).toEqual({ nodes: [], edges: [], startNodeId: "s" });
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
});
