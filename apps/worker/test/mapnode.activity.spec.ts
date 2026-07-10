import { afterEach, describe, expect, it, vi } from "vitest";
import { __mapDeps, mapNode } from "../src/temporal/activities";

const meta = { tenantId: "t-1", executionId: "e-1", nodeId: "n-1" };

afterEach(() => vi.restoreAllMocks());

describe("mapNode (items model A3 batched map)", () => {
  it("fans an agent out over N items and sums cost (per-item recording is inside runAgent)", async () => {
    const runAgent = vi
      .spyOn(__mapDeps, "runAgent")
      .mockImplementation(async (cfg, input) => ({
        status: "ok" as const,
        output: { echo: input },
        model: "m",
        costUsd: 0.01,
      }));
    const items = [
      { cfg: {}, input: { n: 1 } },
      { cfg: {}, input: { n: 2 } },
    ];

    const res = await mapNode("agent", items, meta);

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(res.outputs).toEqual([
      { status: "ok", output: { echo: { n: 1 } }, model: "m", costUsd: 0.01 },
      { status: "ok", output: { echo: { n: 2 } }, model: "m", costUsd: 0.01 },
    ]);
    expect(res.costUsd).toBeCloseTo(0.02);
  });

  it("FAIL-SAFE: a mid-batch failure returns {error} for that item, keeps completed items billed, and never throws", async () => {
    // item 1 (index 1) throws AFTER items 0 + 2 make real (billed) calls.
    const runAgent = vi
      .spyOn(__mapDeps, "runAgent")
      .mockImplementation(async (_cfg, input) => {
        const n = (input as { n: number }).n;
        if (n === 2) throw new Error("provider 500 on item 2");
        return {
          status: "ok" as const,
          output: { n },
          model: "m",
          costUsd: 0.05,
        };
      });
    const items = [1, 2, 3].map((n) => ({ cfg: {}, input: { n } }));

    // Never throws for an item error — returns per-item outputs.
    const res = await mapNode("agent", items, meta, 1); // concurrency 1 → deterministic order

    expect(runAgent).toHaveBeenCalledTimes(3); // every item attempted
    expect(res.outputs[0]).toMatchObject({ output: { n: 1 } });
    expect(res.outputs[1]).toEqual({ error: "provider 500 on item 2" });
    expect(res.outputs[2]).toMatchObject({ output: { n: 3 } });
    // cost = the TWO completed items only (the failed one made no billable return)
    expect(res.costUsd).toBeCloseTo(0.1);
  });

  it("shapes httpRequest output to {status, headers, body}", async () => {
    vi.spyOn(__mapDeps, "callHttpRequest").mockResolvedValue({
      status: "ok",
      httpStatus: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true },
      costUsd: 0,
    });
    const res = await mapNode("httpRequest", [{ cfg: {}, input: {} }], meta);
    expect(res.outputs[0]).toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true },
    });
  });

  it("an empty item list is a no-op (no calls, empty outputs)", async () => {
    const runAgent = vi.spyOn(__mapDeps, "runAgent");
    const res = await mapNode("agent", [], meta);
    expect(runAgent).not.toHaveBeenCalled();
    expect(res).toEqual({ outputs: [], costUsd: 0 });
  });
});
