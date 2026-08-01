import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the read-model. executions.service imports only getPrisma from @naary/db.
const findMany = vi.fn();
const findUnique = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    graphDefinition: { findMany: async () => [] },
    execution: { findMany, findUnique },
    // The public prompt's best-effort "on behalf of Acme" line.
    tenantSettings: { findUnique: async () => ({ displayName: "Acme" }) },
  }),
}));

import { ExecutionsService } from "../src/executions/executions.service";

function makeService(opts: {
  getLatest?: (t: string, k: string) => Promise<unknown>;
  getHandle?: (id: string) => unknown;
}): ExecutionsService {
  const graphs = {
    getLatest: opts.getLatest ?? (async () => null),
  } as never;
  const service = new ExecutionsService(graphs, {
    defaultEnvId: async () => "env-test",
    resolveEnvId: async () => "env-test",
  } as never);
  (service as unknown as { client: unknown }).client = {
    workflow: { getHandle: opts.getHandle ?? (() => ({})) },
  };
  return service;
}

const approvalGraph = {
  graph: {
    startNodeId: "start",
    nodes: [
      { id: "start", type: "start" },
      {
        id: "gate",
        type: "humanApproval",
        config: { title: "Ship it?", instructions: "Check the diff first." },
      },
      { id: "end", type: "end" },
    ],
    edges: [],
  },
};

beforeEach(() => {
  findMany.mockReset();
  findUnique.mockReset();
});

describe("listAwaiting (approvals inbox)", () => {
  it("returns awaiting runs enriched with the node's prompt from the graph", async () => {
    findMany.mockResolvedValue([
      {
        workflowId: "wf-1",
        workflowKey: "ship",
        status: "awaiting_approval",
        createdAt: new Date("2026-07-04T00:00:00Z"),
      },
    ]);
    const service = makeService({
      getLatest: async () => approvalGraph,
      getHandle: () => ({
        query: async () => ({
          status: "awaiting_approval",
          currentNodeId: "gate",
          ctx: {},
        }),
      }),
    });

    const out = await service.listAwaiting("t-1");

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      workflowId: "wf-1",
      workflowKey: "ship",
      nodeId: "gate",
      title: "Ship it?",
      instructions: "Check the diff first.",
    });
  });

  it("resolves the approval prompt graph in the RUN's own env when tagged (Slice 6)", async () => {
    findMany.mockResolvedValue([
      {
        workflowId: "wf-1",
        workflowKey: "ship",
        environmentId: "env-sandbox", // the run executed in sandbox
        status: "awaiting_approval",
        createdAt: new Date("2026-07-04T00:00:00Z"),
      },
    ]);
    const getLatest = vi.fn().mockResolvedValue(approvalGraph);
    const service = makeService({
      getLatest,
      getHandle: () => ({
        query: async () => ({
          status: "awaiting_approval",
          currentNodeId: "gate",
          ctx: {},
        }),
      }),
    });

    await service.listAwaiting("t-1");

    // the graph is read from the run's OWN env (2nd arg), NOT the tenant default ("env-test")
    expect(getLatest).toHaveBeenCalledWith("t-1", "env-sandbox", "ship");
  });

  it("drops a run that was DECIDED since the read-model write (live status not awaiting)", async () => {
    findMany.mockResolvedValue([
      {
        workflowId: "wf-stale",
        workflowKey: "ship",
        status: "awaiting_approval", // stale row
        createdAt: new Date(),
      },
    ]);
    const service = makeService({
      getLatest: async () => approvalGraph,
      getHandle: () => ({
        query: async () => ({ status: "running", currentNodeId: "x", ctx: {} }),
      }),
    });

    expect(await service.listAwaiting("t-1")).toEqual([]);
  });

  it("drops a closed/gone run (query throws) and falls back to a default title", async () => {
    findMany.mockResolvedValue([
      {
        workflowId: "wf-gone",
        workflowKey: null,
        status: "awaiting_approval",
        createdAt: new Date(),
      },
    ]);
    const service = makeService({
      getHandle: () => ({
        query: async () => {
          throw new Error("NOT_FOUND");
        },
      }),
    });

    expect(await service.listAwaiting("t-1")).toEqual([]);
  });
});

describe("approve forwards the reviewer comment to the signal", () => {
  // assertOwner returns the owned row (approve threads it into the access checks).
  const OWNED_ROW = { tenantId: "t-1", workflowKey: null, environmentId: null };

  it("signals { approved, comment } when a comment is given", async () => {
    const signal = vi.fn().mockResolvedValue(undefined);
    const service = makeService({ getHandle: () => ({ signal }) });
    // ownership check hits prisma indirectly — stub it out for this unit.
    vi.spyOn(
      service as unknown as { assertOwner: () => Promise<typeof OWNED_ROW> },
      "assertOwner",
    ).mockResolvedValue(OWNED_ROW);

    await service.approve("wf-1", true, "t-1", "looks good");

    expect(signal).toHaveBeenCalledOnce();
    const [, payload] = signal.mock.calls[0];
    expect(payload).toEqual({ approved: true, comment: "looks good" });
  });

  it("omits comment from the signal when none is given", async () => {
    const signal = vi.fn().mockResolvedValue(undefined);
    const service = makeService({ getHandle: () => ({ signal }) });
    vi.spyOn(
      service as unknown as { assertOwner: () => Promise<typeof OWNED_ROW> },
      "assertOwner",
    ).mockResolvedValue(OWNED_ROW);

    await service.approve("wf-1", false, "t-1");

    expect(signal.mock.calls[0][1]).toEqual({ approved: false });
  });
});

// ---------------------------------------------------------------------------------------------
// #1019 — the prompt renders against the RUN, not as the author typed it.
//
// The reported approval read "Approve automated fix for issue #{{ start.issueNumber }}", which
// tells the approver nothing and makes them go find the run — the opposite of what a durable
// human-in-the-loop pause is for. These cover BOTH API surfaces (the inbox the run-detail and
// approvals screens read, and the public signed approve/reject page) plus the two properties
// that must hold no matter what: secrets stay literal, and nothing is ever silently blanked.
// ---------------------------------------------------------------------------------------------

const TEMPLATED_GRAPH = {
  graph: {
    startNodeId: "start",
    nodes: [
      { id: "start", type: "start" },
      {
        id: "gate",
        type: "humanApproval",
        config: {
          title: "Approve automated fix for issue #{{ start.issueNumber }}",
          instructions:
            "The coding agent prepared a fix for {{ start.owner }}/{{ start.repo }} " +
            "in {{ $vars.REGION }}. Token {{ $secrets.GH_TOKEN }} was used. " +
            "Reviewer: {{ start.reviewer }}.",
        },
      },
      { id: "end", type: "end" },
    ],
    edges: [],
  },
};

// A run ctx as stateQuery returns it — carrying `$secrets` ON PURPOSE (the API never sees one in
// practice, but an absent key would make the "secrets stay literal" assertion below vacuous).
const RUN_CTX = {
  $vars: { REGION: "eu-central" },
  $secrets: { GH_TOKEN: "ghp-super-secret-value" },
  start: { issueNumber: 42, owner: "IFF-Productions", repo: "naary" },
};

const awaitingHandle = (ctx: Record<string, unknown>) => () => ({
  query: async () => ({
    status: "awaiting_approval",
    currentNodeId: "gate",
    ctx,
  }),
});

describe("#1019 approval prompt renders against the run", () => {
  const row = {
    workflowId: "wf-1",
    workflowKey: "fix",
    tenantId: "t-1",
    environmentId: null,
    status: "awaiting_approval",
    createdAt: new Date("2026-07-04T00:00:00Z"),
  };

  it("fills the inbox row's title/instructions from the run ctx", async () => {
    findMany.mockResolvedValue([row]);
    const service = makeService({
      getLatest: async () => TEMPLATED_GRAPH,
      getHandle: awaitingHandle(RUN_CTX),
    });

    const [item] = await service.listAwaiting("t-1");

    expect(item.title).toBe("Approve automated fix for issue #42");
    expect(item.instructions).toContain("IFF-Productions/naary");
    // $vars ARE resolved (the recorded decision — see approval-prompt.ts).
    expect(item.instructions).toContain("eu-central");
  });

  it("keeps $secrets LITERAL — this text is also emailed and posted to Slack", async () => {
    findMany.mockResolvedValue([row]);
    const service = makeService({
      getLatest: async () => TEMPLATED_GRAPH,
      getHandle: awaitingHandle(RUN_CTX),
    });

    const [item] = await service.listAwaiting("t-1");

    expect(JSON.stringify(item)).not.toContain("ghp-super-secret-value");
    expect(item.instructions).toContain("{{ $secrets.GH_TOKEN }}");
  });

  it("keeps an unresolvable reference legible rather than blanking it", async () => {
    findMany.mockResolvedValue([row]);
    const service = makeService({
      getLatest: async () => TEMPLATED_GRAPH,
      getHandle: awaitingHandle(RUN_CTX),
    });

    const [item] = await service.listAwaiting("t-1");

    // `start.reviewer` is absent from ctx: "Reviewer: ." would read as a fact.
    expect(item.instructions).toContain("Reviewer: {{ start.reviewer }}.");
    expect(item.instructions).not.toContain("undefined");
  });

  it("degrades to the authored template when the run has no ctx to render against", async () => {
    findMany.mockResolvedValue([row]);
    const service = makeService({
      getLatest: async () => TEMPLATED_GRAPH,
      getHandle: awaitingHandle({}),
    });

    const [item] = await service.listAwaiting("t-1");

    // Still approvable, and honest about what did not resolve.
    expect(item.title).toBe(
      "Approve automated fix for issue #{{ start.issueNumber }}",
    );
  });

  it("renders the PUBLIC signed approve/reject page's prompt too", async () => {
    findUnique.mockResolvedValue(row);
    const service = makeService({
      getLatest: async () => TEMPLATED_GRAPH,
      getHandle: awaitingHandle(RUN_CTX),
    });

    const prompt = await service.promptByWorkflowId("wf-1");

    expect(prompt.awaiting).toBe(true);
    expect(prompt.title).toBe("Approve automated fix for issue #42");
    expect(prompt.instructions).toContain("IFF-Productions/naary");
    expect(JSON.stringify(prompt)).not.toContain("ghp-super-secret-value");
  });
});
