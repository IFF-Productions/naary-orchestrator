import { beforeEach, describe, expect, it, vi } from "vitest";

// The version-resolution tests stub startGraph out entirely; the budget-gate tests below run the
// REAL startGraph, which reaches execution.create + both budget guards + getBudget — mock those.
const { executionCreate, tenantGate, companyGate } = vi.hoisted(() => ({
  executionCreate: vi.fn(),
  tenantGate: vi.fn(),
  companyGate: vi.fn(),
}));
vi.mock("@naary/db", () => ({
  // #904: this spec has no renamed workflows, so the alias resolver is the identity. A spec
  // that DOES exercise aliases stubs it to return the live key (see workflow-key-alias.spec.ts).
  resolveWorkflowKey: async (_t: string, k: string) => k,
  getPrisma: () => ({ execution: { create: executionCreate } }),
}));
vi.mock("@naary/usage", () => ({
  getBudget: vi.fn().mockResolvedValue(null),
}));
vi.mock("../src/budget/budget-guard", () => ({
  assertWithinMonthlyBudget: tenantGate,
}));
vi.mock("../src/budget/company-budget-guard", () => ({
  assertWithinCompanyMonthlyBudget: companyGate,
}));

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

// The REAL startGraph (no stub) with only its collaborators mocked, to cover the run-start
// budget gating: the per-tenant gate, then the company-wide OUTER gate (both must pass).
function makeGatedService() {
  const service = new ExecutionsService(
    {} as never,
    {
      defaultEnvId: async () => "env-test",
      resolveEnvId: async () => "env-test",
    } as never,
  );
  (service as unknown as { graphs: unknown }).graphs = {
    getLatest: vi.fn().mockResolvedValue(SNAP_LATEST),
    getErrorHandler: vi.fn().mockResolvedValue(null),
  };
  const workflowStart = vi.fn().mockResolvedValue({});
  (service as unknown as { client: unknown }).client = {
    workflow: { start: workflowStart },
  };
  return { service, workflowStart };
}

describe("startGraph (budget gates)", () => {
  beforeEach(() => {
    executionCreate.mockReset().mockResolvedValue({});
    tenantGate.mockReset();
    companyGate.mockReset();
  });

  it("runs the TENANT gate first, then the company OUTER gate — both before the workflow starts", async () => {
    const order: string[] = [];
    tenantGate.mockImplementation(async () => {
      order.push("tenant");
    });
    companyGate.mockImplementation(async () => {
      order.push("company");
    });
    const { service, workflowStart } = makeGatedService();

    await service.start("t1", "e1", { x: 1 }, "refunds");

    expect(order).toEqual(["tenant", "company"]); // tenant gate first, company gate second
    expect(companyGate).toHaveBeenCalledWith("t1");
    expect(workflowStart).toHaveBeenCalledTimes(1);
  });

  it("propagates the company gate's 402 and does NOT start the workflow", async () => {
    tenantGate.mockResolvedValue(undefined); // tenant cap passes…
    const err = new Error("company cap exceeded (402)");
    companyGate.mockRejectedValue(err); // …but the company OUTER gate rejects
    const { service, workflowStart } = makeGatedService();

    await expect(service.start("t1", "e1", { x: 1 }, "refunds")).rejects.toBe(
      err,
    );
    expect(workflowStart).not.toHaveBeenCalled();
    expect(executionCreate).not.toHaveBeenCalled();
  });
});

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

/**
 * What a manually-started run is handed as its trigger input (#979).
 *
 * The rule is `body.input → Start node's sampleInput → {}`, and the last step is the one with
 * history: it used to be a hardcoded `{ message: "I was charged twice this month" }` support-ticket
 * payload left over from the demo seed graph. That made "Run now" structurally different from every
 * real trigger — cron and poll schedules start a run with `{}` — so manually testing a scheduled
 * workflow fed it data the schedule would never send, and the run failed for a reason that could
 * not happen in production. `sampleInput` is declared on the `start` node type ONLY, so a
 * scheduleTrigger graph had no way to override it either.
 *
 * These assert the input positionally out of the stubbed `startGraph` (3rd arg) rather than
 * trusting a return value, because the input is not otherwise observable from `start()`.
 */
describe("start (trigger input)", () => {
  const inputOf = (startGraph: { mock: { calls: unknown[][] } }) =>
    startGraph.mock.calls[0][2];

  it("passes the caller's input through untouched", async () => {
    const { service, getLatest, startGraph } = makeService();
    getLatest.mockResolvedValue(SNAP_LATEST);

    await service.start("t1", "e1", { ticketId: "NAARY-42" }, "refunds");

    expect(inputOf(startGraph)).toEqual({ ticketId: "NAARY-42" });
  });

  it("falls back to the Start node's sampleInput when the caller passes none", async () => {
    const { service, getLatest, startGraph } = makeService();
    getLatest.mockResolvedValue({
      ...SNAP_LATEST,
      graph: {
        startNodeId: "s",
        nodes: [
          {
            id: "s",
            type: "start",
            config: { sampleInput: { message: "hello" } },
          },
        ],
        edges: [],
      },
    });

    await service.start("t1", "e1", undefined, "refunds");

    expect(inputOf(startGraph)).toEqual({ message: "hello" });
  });

  it("an explicit input BEATS the Start node's sampleInput", async () => {
    const { service, getLatest, startGraph } = makeService();
    getLatest.mockResolvedValue({
      ...SNAP_LATEST,
      graph: {
        startNodeId: "s",
        nodes: [
          {
            id: "s",
            type: "start",
            config: { sampleInput: { message: "hello" } },
          },
        ],
        edges: [],
      },
    });

    await service.start("t1", "e1", { message: "typed by hand" }, "refunds");

    expect(inputOf(startGraph)).toEqual({ message: "typed by hand" });
  });

  // The regression. A scheduleTrigger graph cannot declare a sampleInput at all (the field is on
  // `start` only), so whatever this branch produces is what EVERY manual run of EVERY scheduled
  // workflow gets. It must match what syncCronSchedule actually passes, which is `{}`.
  it("hands a scheduleTrigger graph the same EMPTY input its cron does — no demo payload", async () => {
    const { service, getLatest, startGraph } = makeService();
    getLatest.mockResolvedValue({
      ...SNAP_LATEST,
      graph: {
        startNodeId: "cron",
        nodes: [
          {
            id: "cron",
            type: "scheduleTrigger",
            config: { cron: "*/5 * * * *" },
          },
        ],
        edges: [],
      },
    });

    await service.start("t1", "e1", undefined, "nightly-report");

    expect(inputOf(startGraph)).toEqual({});
  });

  // Guards the general shape, not just the schedule case: no graph gets invented trigger data.
  // Asserted as a substring scan so a DIFFERENT invented payload can't quietly take its place.
  it("invents no trigger data for a graph with no sampleInput", async () => {
    const { service, getLatest, startGraph } = makeService();
    getLatest.mockResolvedValue(SNAP_LATEST); // GRAPH: a bare start node, no config

    await service.start("t1", "e1", undefined, "refunds");

    expect(inputOf(startGraph)).toEqual({});
    expect(JSON.stringify(inputOf(startGraph))).not.toMatch(/charged|message/i);
  });

  // #983 closed the gap the comment above names: entry nodes OTHER than `start` can now declare a
  // sample. Deliberately a LOCK, not a regression test — it passes on the old code too, because
  // `startSampleInput` always read `graph.startNodeId`'s config regardless of node type. That is
  // the point worth pinning: the fix was in the DSL schema and the canvas, and this asserts the
  // service keeps needing no special case per trigger type.
  it("reads a WEBHOOK trigger's sampleInput on a manual run (one rule, any entry node)", async () => {
    const { service, getLatest, startGraph } = makeService();
    getLatest.mockResolvedValue({
      ...SNAP_LATEST,
      graph: {
        startNodeId: "hook",
        nodes: [
          {
            id: "hook",
            type: "webhookTrigger",
            config: { sampleInput: { event: "ticket.created" } },
          },
        ],
        edges: [],
      },
    });

    await service.start("t1", "e1", undefined, "on-ticket");

    expect(inputOf(startGraph)).toEqual({ event: "ticket.created" });
  });
});

// RBAC G1 (§4): manual starts carry an actor and are `run`-gated; trigger paths
// carry NO principal and must stay byte-identical (workspace-level automation).
import { ForbiddenException } from "@nestjs/common";
import type { Principal } from "../src/auth/tenant.decorator";
import type { PermissionsService } from "../src/permissions/permissions.service";

describe("start (G1 run gate)", () => {
  const member: Principal = { tenantId: "t1", userId: "u-1", role: "member" };

  function makePermService(assertCan: ReturnType<typeof vi.fn>) {
    const service = new ExecutionsService(
      {} as never,
      {
        defaultEnvId: async () => "env-test",
        resolveEnvId: async () => "env-test",
      } as never,
      { assertCan } as unknown as PermissionsService,
    );
    const getLatest = vi.fn().mockResolvedValue(SNAP_LATEST);
    (service as unknown as { graphs: unknown }).graphs = { getLatest };
    const startGraph = vi
      .spyOn(
        service as unknown as {
          startGraph: (...a: unknown[]) => Promise<unknown>;
        },
        "startGraph",
      )
      .mockResolvedValue({ workflowId: "wf-new" });
    return { service, getLatest, startGraph };
  }

  it("denies a restricted member BEFORE the graph is even read", async () => {
    const assertCan = vi.fn().mockRejectedValue(new ForbiddenException("no"));
    const { service, getLatest, startGraph } = makePermService(assertCan);
    await expect(
      service.start("t1", "e1", { x: 1 }, "refunds", undefined, member),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(assertCan).toHaveBeenCalledWith(member, "run", "refunds", "e1");
    expect(getLatest).not.toHaveBeenCalled();
    expect(startGraph).not.toHaveBeenCalled();
  });

  it("a GRANTED member's start proceeds", async () => {
    const assertCan = vi.fn().mockResolvedValue(undefined);
    const { service, startGraph } = makePermService(assertCan);
    await service.start("t1", "e1", { x: 1 }, "refunds", undefined, member);
    expect(startGraph).toHaveBeenCalledTimes(1);
  });

  it("an actor-less start (trigger/internal path) never consults permissions", async () => {
    const assertCan = vi.fn();
    const { service, startGraph } = makePermService(assertCan);
    await service.start("t1", "e1", { x: 1 }, "refunds");
    expect(assertCan).not.toHaveBeenCalled();
    expect(startGraph).toHaveBeenCalledTimes(1);
  });

  it("an actor WITHOUT wired permissions fails CLOSED", async () => {
    const service = new ExecutionsService(
      {} as never,
      {
        defaultEnvId: async () => "env-test",
        resolveEnvId: async () => "env-test",
      } as never,
    );
    await expect(
      service.start("t1", "e1", undefined, "refunds", undefined, member),
    ).rejects.toThrow(/PermissionsService is not wired/);
  });
});
