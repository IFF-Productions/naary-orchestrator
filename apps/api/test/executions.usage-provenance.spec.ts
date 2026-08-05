/**
 * `queryState` joins the usage ledger so run detail can tell an ESTIMATE from a MEASUREMENT
 * (#1069, follow-up to #1060).
 *
 * The run's per-step cost and tokens come from each node's own OUTPUT in the run ctx, and an
 * output cannot say which kind of number it holds — by the time a rule-6 fallback estimate has
 * been turned into a token count, an estimated 900 and a measured 900 are the same integer. The
 * `UsageEvent` row for `(executionId, nodeId)` does know. So the run state carries that ONE bit
 * across from the ledger, and nothing else.
 *
 * "Nothing else" is load-bearing, and the third test pins it: the ledger's own cost/tokens are
 * deliberately NOT surfaced, because they are a different number on purpose — an agent node's
 * output cost includes flat MCP tool spend the token ledger has no row for, and a node that ran
 * several passes has exactly ONE ledger row (recordUsage upserts on (executionId, nodeId), first
 * write wins). Rendering ledger figures as the step's would drop tool spend and show pass-1
 * numbers for a looped node — a new confidently-wrong answer in place of the old one.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

const usageFindMany = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ usageEvent: { findMany: usageFindMany } }),
}));

import type { ExecutionsDeps } from "../src/executions/executions.queries";
import { queryState } from "../src/executions/executions.queries";

const TENANT = "11111111-2222-3333-4444-555555555555";

const ROW = {
  tenantId: TENANT,
  workflowKey: "support-triage",
  environmentId: "env-1",
  failedNodeId: null,
  executedNodeIds: ["start", "agent-1", "agent-2", "http-1"],
};

/** A completed run: two agent steps and an HTTP step, each with its output's own figures. */
const CTX = {
  __input: { ticket: 42 },
  "agent-1": { text: "triaged", totalTokens: 900, costUsd: 0.004 },
  "agent-2": { text: "replied", totalTokens: 1200, costUsd: 0.006 },
  "http-1": { httpStatus: 200, body: { ok: true } },
};

function deps(): ExecutionsDeps {
  return {
    client: {
      workflow: {
        getHandle: () => ({
          describe: async () => ({ status: { name: "COMPLETED" } }),
          result: async () => ({
            status: "completed",
            ctx: CTX,
            currentNodeId: "end",
          }),
          query: async () => {
            throw new Error("closed");
          },
          fetchHistory: async () => ({ events: [] }),
        }),
      },
    },
    assertOwner: async () => ROW,
    assertRunAccess: async () => undefined,
    perms: () => ({}) as never,
  } as unknown as ExecutionsDeps;
}

beforeEach(() => {
  vi.restoreAllMocks();
  usageFindMany.mockReset();
});

describe("queryState — ledger provenance for the run's billed nodes", () => {
  it("reports estimated for the fallback row, measured for the metered one, and NOTHING for a node that never billed", async () => {
    usageFindMany.mockResolvedValue([
      { nodeId: "agent-1", estimated: true },
      { nodeId: "agent-2", estimated: false },
    ]);

    const s = await queryState(deps(), "wf-1", TENANT);

    expect(s.nodeUsage["agent-1"]).toEqual({ estimated: true });
    expect(s.nodeUsage["agent-2"]).toEqual({ estimated: false });
    // The HTTP step has no ledger row, and the map must NOT invent `{ estimated: false }` for it.
    // An absent key is "no claim"; a false would be the claim "this was measured", which we have
    // no basis for — the same class of bug in the other direction.
    expect("http-1" in s.nodeUsage).toBe(false);
  });

  it("scopes the ledger read to this run AND this tenant", async () => {
    usageFindMany.mockResolvedValue([]);
    await queryState(deps(), "wf-1", TENANT);
    expect(usageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { executionId: "wf-1", tenantId: TENANT },
      }),
    );
  });

  it("takes only the provenance bit from the ledger, never its cost or tokens", async () => {
    // A ledger row whose figures DIFFER from the node output's — which is normal, not a bug: the
    // ledger books token cost only, while the node's output adds flat MCP tool spend on top.
    usageFindMany.mockResolvedValue([
      { nodeId: "agent-1", estimated: true, costUsd: 0.001, totalTokens: 111 },
    ]);

    const s = await queryState(deps(), "wf-1", TENANT);

    expect(s.nodeUsage["agent-1"]).toEqual({ estimated: true });
    // The ctx the UI actually renders its numbers from is untouched by the join.
    expect(s.ctx["agent-1"]).toEqual(CTX["agent-1"]);
  });

  it("still returns the run when the ledger read fails", async () => {
    // The outputs, timings and error are why someone opened this page. Losing an "estimated"
    // marker is a far smaller harm than a 500 that shows them nothing at all — and `{}` is not a
    // lie, it is precisely "we have no provenance to report".
    usageFindMany.mockRejectedValue(new Error("pg down"));

    const s = await queryState(deps(), "wf-1", TENANT);

    expect(s.nodeUsage).toEqual({});
    expect(s.ctx["agent-1"]).toEqual(CTX["agent-1"]);
    expect(s.status).toBe("completed");
  });
});
