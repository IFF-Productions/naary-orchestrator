import { describe, expect, it, vi } from "vitest";
import { ExecutionsService } from "../src/executions/executions.service";

/** Build a service with `startWebhook` stubbed + a fake Temporal client handle, so
 *  only the response poll loop is exercised. */
function makeService(handle: { query: unknown; describe: unknown }) {
  const service = new ExecutionsService(
    {} as never,
    {
      defaultEnvId: async () => "env-test",
      resolveEnvId: async () => "env-test",
    } as never,
  );
  vi.spyOn(service, "startWebhook").mockResolvedValue({ workflowId: "wf-1" });
  (service as unknown as { client: unknown }).client = {
    workflow: { getHandle: () => handle },
  };
  return service;
}

const snapshot = { graph: { nodes: [], edges: [], startNodeId: "s" } } as never;

describe("startWebhookAwaitResponse", () => {
  it("returns the response once the node sets it", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(undefined) // not set yet
      .mockResolvedValueOnce({ statusCode: 201, body: { ok: true } });
    const describe = vi.fn().mockResolvedValue({ status: { name: "RUNNING" } });
    const service = makeService({ query, describe });

    const out = await service.startWebhookAwaitResponse(
      "t-1",
      "e-1",
      snapshot,
      {},
      "wk",
      { timeoutMs: 1000, pollMs: 1 },
    );
    expect(out).toEqual({
      workflowId: "wf-1",
      response: { statusCode: 201, body: { ok: true } },
    });
  });

  it("degrades to no response when the run closes without ever responding", async () => {
    // undefined on every query, including the final post-close re-query.
    const query = vi.fn().mockResolvedValue(undefined);
    const describe = vi
      .fn()
      .mockResolvedValue({ status: { name: "COMPLETED" } });
    const service = makeService({ query, describe });

    const out = await service.startWebhookAwaitResponse(
      "t-1",
      "e-1",
      snapshot,
      {},
      "wk",
      { timeoutMs: 1000, pollMs: 1 },
    );
    expect(out).toEqual({ workflowId: "wf-1" });
    expect(query).toHaveBeenCalledTimes(2); // in-loop query + the post-close re-query
  });

  it("RACE: run responds AND completes between the query and the describe → still returns it", async () => {
    // Poll 1: not set yet. describe: already COMPLETED. Final re-query: response is there.
    const query = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ statusCode: 201, body: { late: true } });
    const describe = vi
      .fn()
      .mockResolvedValue({ status: { name: "COMPLETED" } });
    const service = makeService({ query, describe });

    const out = await service.startWebhookAwaitResponse(
      "t-1",
      "e-1",
      snapshot,
      {},
      "wk",
      { timeoutMs: 1000, pollMs: 1 },
    );
    expect(out).toEqual({
      workflowId: "wf-1",
      response: { statusCode: 201, body: { late: true } },
    });
  });

  it("degrades to no response on timeout (still running, never responds)", async () => {
    const query = vi.fn().mockResolvedValue(undefined);
    const describe = vi.fn().mockResolvedValue({ status: { name: "RUNNING" } });
    const service = makeService({ query, describe });

    const out = await service.startWebhookAwaitResponse(
      "t-1",
      "e-1",
      snapshot,
      {},
      "wk",
      { timeoutMs: 20, pollMs: 5 },
    );
    expect(out).toEqual({ workflowId: "wf-1" });
  });

  it("keeps polling through a transient query error, then succeeds", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("worker hiccup"))
      .mockResolvedValue({ statusCode: 200, body: "ok" });
    const describe = vi.fn().mockResolvedValue({ status: { name: "RUNNING" } });
    const service = makeService({ query, describe });

    const out = await service.startWebhookAwaitResponse(
      "t-1",
      "e-1",
      snapshot,
      {},
      "wk",
      { timeoutMs: 1000, pollMs: 1 },
    );
    expect(out.response).toEqual({ statusCode: 200, body: "ok" });
  });
});
