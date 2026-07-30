// A CLOSED run's per-node outputs in the run detail (queryState).
//
// Reported as "all outputs of each step in the Run Details are gone" and "it's always saying no
// output recorded on the step" — with a screenshot of a run whose sub-workflow step was red, every
// duration showing `—`, and the selected integration step saying "No output was recorded for this
// step" where its response body should be.
//
// That combination pins the branch precisely. States rendered (so `executedNodeIds` came back),
// durations empty (so `nodeTimes` was null), outputs empty (so `ctx` was `{}`) — the Temporal-level
// FAILURE branch, which assumed a thrown workflow's ctx was unrecoverable. It isn't: a closed
// workflow can still be queried, and Temporal replays its history to answer.
//
// These tests own the recovery in both directions — it must fill the outputs in when the replay
// works, and must not make a failed run WORSE when it doesn't.
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryState } from "../src/executions/executions.queries";
import type { ExecutionsDeps } from "../src/executions/executions.queries";

const TENANT = "11111111-2222-3333-4444-555555555555";

const ROW = {
  tenantId: TENANT,
  workflowKey: "pagerduty-incident-triage",
  environmentId: "env-1",
  failedNodeId: "subflow",
  executedNodeIds: ["schedule", "pagerduty", "check", "agent", "subflow"],
};

/** The ctx a failed run had built by the time it threw — what the user wanted to see. */
const FAILED_CTX = {
  __input: { source: "schedule" },
  __costUsd: 0.02,
  pagerduty: {
    status: 200,
    body: { incidents: [{ id: "PD-1", title: "API latency" }] },
  },
  agent: { text: "One open incident.", totalTokens: 812 },
  __nodeTimes: { pagerduty: { s: 1000, f: 1400 } },
};

function makeDeps(over: {
  describeStatus: string;
  query?: () => Promise<unknown>;
  result?: () => Promise<unknown>;
}): ExecutionsDeps {
  return {
    client: {
      workflow: {
        getHandle: () => ({
          describe: async () => ({ status: { name: over.describeStatus } }),
          query:
            over.query ??
            (async () => {
              throw new Error("no query");
            }),
          result:
            over.result ??
            (async () => {
              throw new Error("no result");
            }),
          fetchHistory: async () => ({ events: [] }),
        }),
      },
    },
    assertOwner: async () => ROW,
    assertRunAccess: async () => undefined,
    perms: () => ({}) as never,
  } as unknown as ExecutionsDeps;
}

beforeEach(() => vi.restoreAllMocks());

describe("queryState — a run that FAILED at the Temporal level", () => {
  it("recovers every node's output by replaying the closed workflow", async () => {
    const deps = makeDeps({
      describeStatus: "FAILED",
      query: async () => ({
        status: "failed",
        currentNodeId: "subflow",
        ctx: FAILED_CTX,
        spentUsd: 0.02,
      }),
    });

    const out = await queryState(deps, "wf-1", TENANT);

    // The whole point: the outputs are THERE, so the step card renders the response body it was
    // hiding behind "No output was recorded for this step".
    expect(out.ctx.pagerduty).toEqual({
      status: 200,
      body: { incidents: [{ id: "PD-1", title: "API latency" }] },
    });
    expect(out.ctx.agent).toMatchObject({ totalTokens: 812 });
    // …and the per-step durations that were all showing `—`.
    expect(out.nodeTimes).not.toBeNull();
    expect(out.spentUsd).toBe(0.02);
    // The run is still FAILED, still pointing at the node that died — recovery must not restate
    // the outcome. failedNodeId is the read-model's, not the replay's (#525).
    expect(out.status).toBe("failed");
    expect(out.currentNodeId).toBe("subflow");
    // The stamp is kept alongside the ctx: a node can run and write nothing (`end`), and dropping
    // it would regress those steps to "skipped".
    expect(out.executedNodeIds).toEqual(ROW.executedNodeIds);
  });

  it("still renders the failed run when the replay is unavailable", async () => {
    // An aged-out history / rejected query must leave the previous behaviour exactly intact —
    // recovery is additive, never a new way for the detail view to break.
    const deps = makeDeps({
      describeStatus: "FAILED",
      query: async () => {
        throw new Error("workflow history not found");
      },
    });

    const out = await queryState(deps, "wf-1", TENANT);

    expect(out.status).toBe("failed");
    expect(out.currentNodeId).toBe("subflow");
    expect(out.ctx).toEqual({});
    expect(out.executedNodeIds).toEqual(ROW.executedNodeIds);
  });

  it("does NOT replay for a status the SPA keeps polling", async () => {
    // The run detail polls every 1.5s until the status is terminal, and "unknown" never is. A
    // replay here would fire a full history replay every 1.5s for as long as the tab is open.
    const query = vi.fn();
    const deps = makeDeps({ describeStatus: "SOMETHING_NEW", query });
    const out = await queryState(deps, "wf-1", TENANT);
    expect(out.status).toBe("unknown");
    expect(query).not.toHaveBeenCalled();
  });

  it("ignores a replay that answers with a non-object ctx", async () => {
    const deps = makeDeps({
      describeStatus: "TERMINATED",
      query: async () => ({
        status: "terminated",
        currentNodeId: "",
        ctx: null,
      }),
    });

    const out = await queryState(deps, "wf-1", TENANT);
    expect(out.status).toBe("terminated");
    expect(out.ctx).toEqual({});
  });
});

describe("queryState — a COMPLETED run whose result() gives nothing", () => {
  const completedHistory = (ctx: unknown) => ({
    events: [
      { workflowExecutionStartedEventAttributes: {} },
      {
        workflowExecutionCompletedEventAttributes: {
          result: {
            payloads: [
              {
                metadata: { encoding: Buffer.from("json/plain") },
                data: Buffer.from(
                  JSON.stringify({
                    status: "completed",
                    ctx,
                    currentNodeId: "end",
                  }),
                ),
              },
            ],
          },
        },
      },
    ],
  });

  it("falls back to the completion event in history when result() throws", async () => {
    const deps = {
      ...makeDeps({ describeStatus: "COMPLETED" }),
    } as ExecutionsDeps;
    (
      deps.client as unknown as { workflow: { getHandle: () => unknown } }
    ).workflow.getHandle = () => ({
      describe: async () => ({ status: { name: "COMPLETED" } }),
      result: async () => {
        throw new Error("could not fetch result");
      },
      query: async () => {
        throw new Error("no query");
      },
      fetchHistory: async () =>
        completedHistory({ pagerduty: { status: 200 } }),
    });

    const out = await queryState(deps, "wf-2", TENANT);
    // The same history this request can already read for the graph also holds the result.
    expect(out.ctx.pagerduty).toEqual({ status: 200 });
    expect(out.status).toBe("completed");
    expect(out.currentNodeId).toBe("end");
  });

  it("recovers when result() RESOLVES with a null ctx, fetching history once", async () => {
    // The other half of the same failure: `handle.result()` succeeding but carrying nothing
    // usable reaches the UI identically to it throwing.
    const fetchHistory = vi
      .fn()
      .mockResolvedValue(completedHistory({ pagerduty: { status: 200 } }));
    const deps = makeDeps({ describeStatus: "COMPLETED" });
    (
      deps.client as unknown as { workflow: { getHandle: () => unknown } }
    ).workflow.getHandle = () => ({
      describe: async () => ({ status: { name: "COMPLETED" } }),
      result: async () => ({ status: "completed", ctx: null }),
      query: async () => {
        throw new Error("no query");
      },
      fetchHistory,
    });

    const out = await queryState(deps, "wf-3", TENANT);
    expect(out.ctx.pagerduty).toEqual({ status: 200 });
    // ONE history read. Reading `r.ctx` downstream used to throw on the null (nodeTimesFrom
    // indexes its argument), landing in the catch and re-fetching the same history a second
    // time — plus logging a second, misleading failure for what is just "there was no ctx".
    expect(fetchHistory).toHaveBeenCalledTimes(1);
  });

  it("does not accept an ARRAY as a ctx", async () => {
    // `typeof [] === "object"`, so a bare typeof check would hand an array downstream as if it
    // were a node-id → output map.
    const deps = makeDeps({ describeStatus: "COMPLETED" });
    (
      deps.client as unknown as { workflow: { getHandle: () => unknown } }
    ).workflow.getHandle = () => ({
      describe: async () => ({ status: { name: "COMPLETED" } }),
      result: async () => ({ status: "completed", ctx: [1, 2, 3] }),
      query: async () => {
        throw new Error("no query");
      },
      fetchHistory: async () =>
        completedHistory({ pagerduty: { status: 200 } }),
    });

    const out = await queryState(deps, "wf-4", TENANT);
    expect(Array.isArray(out.ctx)).toBe(false);
    expect(out.ctx.pagerduty).toEqual({ status: 200 });
  });

  it("handles an unrecoverable null ctx WITHOUT throwing into the catch", async () => {
    // The case the normalization exists for. Reading `r.ctx` downstream throws here — the ctx is
    // null and `nodeTimesFrom` indexes its argument — which lands in the catch, re-fetches the
    // SAME history a second time, and logs a second misleading failure for what is really just
    // "there was no ctx".
    //
    // The call count is what distinguishes the two paths: both end up returning the same view, so
    // asserting only on the response would pass either way (it did — a mutation test caught that
    // this assertion was missing).
    const fetchHistory = vi.fn().mockResolvedValue({ events: [] });
    const deps = makeDeps({ describeStatus: "COMPLETED" });
    (
      deps.client as unknown as { workflow: { getHandle: () => unknown } }
    ).workflow.getHandle = () => ({
      describe: async () => ({ status: { name: "COMPLETED" } }),
      result: async () => ({ status: "completed", ctx: null }),
      query: async () => {
        throw new Error("no query");
      },
      fetchHistory,
    });

    const out = await queryState(deps, "wf-5", TENANT);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    expect(out.ctx).toEqual({});
    // …and a completed run with no recoverable ctx keeps the read-model stamp, so its steps don't
    // read "skipped" on top of a missing output (#525).
    expect(out.executedNodeIds).toEqual(ROW.executedNodeIds);
    expect(out.nodeTimes).toBeNull();
  });
});
