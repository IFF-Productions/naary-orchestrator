/**
 * `diagnoseAndPropose` scores the model's proposal with `diffGraphs` and DROPS it when the score
 * is zero ("a fix that changes nothing is not a proposal"). That makes the sum a correctness
 * surface, not bookkeeping: any kind of change missing from it is a class of fix the healer can
 * never deliver, and it fails silently — the log line says the model proposed nothing.
 *
 * #1020 added `edgesChanged` (an edited edge CONDITION, which used to land in edgesAdded +
 * edgesRemoved). A retargeted threshold is one of the commonest fixes there is, so this asserts
 * such a proposal survives the guard and is counted as a change rather than an add plus a delete.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphDef } from "@naary/dsl";

const findFirst = vi.hoisted(() => vi.fn());
const create = vi.hoisted(() => vi.fn());

vi.mock("@naary/db", () => ({
  getPrisma: () => ({ workflowFixProposal: { findFirst, create } }),
}));

import { makeHealActivities } from "../src/heal/heal-activities";

const TENANT = "11111111-2222-3333-4444-555555555555";

/** A router whose branch fires above `threshold` — the shape an AI fix retargets. */
const graphAt = (threshold: number): GraphDef => ({
  startNodeId: "start",
  nodes: [
    { id: "start", type: "webhookTrigger" },
    {
      id: "page",
      type: "httpRequest",
      config: { url: "https://ops.test/page" },
    },
    { id: "ignore", type: "end" },
  ],
  edges: [
    {
      from: "start",
      to: "page",
      condition: { path: "start.body.count", op: "gt", value: threshold },
    },
    { from: "start", to: "ignore" },
  ],
});

const INPUT = {
  runId: "exec-1",
  tenantId: TENANT,
  environmentId: "env-1",
  workflowKey: "ops-escalation",
  failedNodeId: "page",
  failureKind: "HTTP",
  failureMessage: "paged on every request",
};

function activities(proposed: GraphDef) {
  return makeHealActivities({
    graphs: {
      getLatest: vi.fn().mockResolvedValue({ graph: graphAt(5), version: 7 }),
    } as never,
    generator: {
      editStream: vi.fn().mockResolvedValue({ graph: proposed }),
    } as never,
    client: {
      workflow: {
        getHandle: () => ({ query: vi.fn().mockResolvedValue({ ctx: {} }) }),
      },
    } as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue(null);
  create.mockResolvedValue({ id: "p-1" });
});

describe("diagnoseAndPropose — scoring the proposal", () => {
  it("keeps a proposal whose ONLY change is an edge condition (5 → 10)", async () => {
    const ref = await activities(graphAt(10)).diagnoseAndPropose(INPUT);
    expect(ref).toEqual({ id: "p-1" });
    expect(create).toHaveBeenCalledTimes(1);
    // Counted as a CHANGE. Before #1020 the same edit scored +1 added and −1 removed, which
    // described routing being torn out and rebuilt.
    expect(create.mock.calls[0][0].data.diffSummary).toEqual({
      add: 0,
      chg: 1,
      del: 0,
      total: 1,
    });
  });

  it("still drops a proposal that changes nothing at all", async () => {
    const ref = await activities(graphAt(5)).diagnoseAndPropose(INPUT);
    expect(ref).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});
