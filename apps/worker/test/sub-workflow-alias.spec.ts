/**
 * #904 — a RENAMED workflow is still reachable from another graph's node config.
 *
 * `executeSubWorkflow.workflowKey`, `forEach.workflowKey` and a run's bound `errorWorkflowKey` are
 * the references the rename deliberately does NOT rewrite: they live inside OTHER graphs' JSON
 * bodies, across every version and every environment, and a stale one fails at RUN time rather
 * than at save time. They keep working because `resolveSubWorkflowGraph` — the worker's ONLY
 * by-key graph read, in a different process from the API — resolves through the alias table.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const resolveWorkflowKey = vi.fn(async (_t: string, k: string) => k);
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ graphDefinition: { findFirst } }),
  getDefaultEnvironmentId: async () => "env-default",
  // Wrapped rather than passed by reference: `vi.mock` is hoisted above the `const`, so naming the
  // spy directly in the factory hits its TDZ. The indirection defers the read to call time.
  resolveWorkflowKey: (t: string, k: string) => resolveWorkflowKey(t, k),
  Prisma: {},
}));

import { resolveSubWorkflowGraph } from "../src/temporal/activities/execution";

const graph = {
  startNodeId: "a",
  nodes: [{ id: "a", type: "start" }],
  edges: [],
};

beforeEach(() => {
  findFirst.mockReset();
  resolveWorkflowKey.mockReset();
  resolveWorkflowKey.mockImplementation(async (_t: string, k: string) => k);
});

describe("resolveSubWorkflowGraph — alias resolution", () => {
  it("looks the child graph up under the LIVE key when the config holds a retired one", async () => {
    resolveWorkflowKey.mockResolvedValue("invoice-sync");
    findFirst.mockResolvedValue({ graph, version: 7 });

    const res = await resolveSubWorkflowGraph({
      tenantId: "t-1",
      environmentId: "env-prod",
      // The parent graph was saved before the child was renamed and still says this.
      workflowKey: "untitled-workflow",
    });

    expect(resolveWorkflowKey).toHaveBeenCalledWith("t-1", "untitled-workflow");
    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      tenantId: "t-1",
      environmentId: "env-prod",
      workflowKey: "invoice-sync",
    });
    expect(res.version).toBe(7);
  });

  it("passes an un-aliased key straight through (the overwhelmingly common case)", async () => {
    findFirst.mockResolvedValue({ graph, version: 1 });
    await resolveSubWorkflowGraph({
      tenantId: "t-1",
      environmentId: "env-prod",
      workflowKey: "billing",
    });
    expect(findFirst.mock.calls[0][0].where.workflowKey).toBe("billing");
  });

  it("still fails NON-RETRYABLY when neither the key nor an alias resolves to a graph", async () => {
    findFirst.mockResolvedValue(null);
    await expect(
      resolveSubWorkflowGraph({
        tenantId: "t-1",
        environmentId: "env-prod",
        workflowKey: "gone",
      }),
    ).rejects.toMatchObject({
      type: "SUBWORKFLOW_GRAPH_NOT_FOUND",
      nonRetryable: true,
    });
  });
});
