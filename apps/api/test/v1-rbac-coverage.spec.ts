import { ForbiddenException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

// RBAC G3 — v1 COVERAGE: the public /api/v1 workflows + runs routes, driven through the
// REAL services and the REAL PermissionsService (only Prisma/Temporal are stubbed), for
// BOTH gated subject kinds: a member-tier Firebase caller and a RESTRICTED API token
// (principal.tokenId — the §4a guard stamp). G1 threaded the principal through these
// controllers; this spec PROVES the thread end-to-end: 403 on ungranted verbs, list
// filtering, and granted-path 200s — with the real union/env-matching/first-grant-cliff
// semantics, not a mocked permissions layer.

const grantFindFirst = vi.fn();
const grantFindMany = vi.fn();
const graphFindMany = vi.fn();
const graphFindFirst = vi.fn();
const activationFindMany = vi.fn();
const tagFindMany = vi.fn();
const execFindMany = vi.fn();
const execFindUnique = vi.fn();
vi.mock("@naary/db", () => ({
  // #904: this spec has no renamed workflows, so the alias resolver is the identity. A spec
  // that DOES exercise aliases stubs it to return the live key (see workflow-key-alias.spec.ts).
  resolveWorkflowKey: async (_t: string, k: string) => k,
  getPrisma: () => ({
    workflowGrant: { findFirst: grantFindFirst, findMany: grantFindMany },
    graphDefinition: { findMany: graphFindMany, findFirst: graphFindFirst },
    workflowActivation: { findMany: activationFindMany },
    workflowTag: { findMany: tagFindMany },
    execution: { findMany: execFindMany, findUnique: execFindUnique },
    // Company second-source lookups (standalone workspace here — no company grants).
    tenantSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    companyWorkflowGrant: { findMany: vi.fn().mockResolvedValue([]) },
  }),
}));

import type { Principal } from "../src/auth/tenant.decorator";
import { ExecutionsService } from "../src/executions/executions.service";
import { GraphsService } from "../src/graphs/graphs.service";
import { PermissionsCache } from "../src/permissions/permissions-cache";
import { PermissionsService } from "../src/permissions/permissions.service";
import { V1RunsController } from "../src/v1/v1-runs.controller";
import { V1WorkflowsController } from "../src/v1/v1-workflows.controller";

/** Member-tier Firebase caller (the guard resolved role=member for the workspace). */
const memberUser: Principal = {
  tenantId: "t-1",
  userId: "u-mem",
  subject: "u-mem",
  role: "member",
};
/** RESTRICTED `nry_` token (§4a): the guard stamped member + tokenId. */
const restrictedToken: Principal = {
  tenantId: "t-1",
  role: "member",
  tokenId: "tok-1",
};

/** A WorkflowGrant row as Prisma returns it (workflows = the key-list include). */
function grant(over: Record<string, unknown> = {}) {
  return {
    environmentId: null,
    scope: "selected",
    canView: false,
    canRun: false,
    canEdit: false,
    canDelete: false,
    canShare: false,
    canCreate: false,
    workflows: [] as { workflowKey: string }[],
    ...over,
  };
}

/** The tenant is ENFORCED (≥1 grant); users resolve to `userGrants`, tokens to
 *  `tokenGrants` — keyed off the real subject join the service queries with. */
function enforce(userGrants: unknown[], tokenGrants: unknown[] = []): void {
  grantFindFirst.mockResolvedValue({ id: "g-1" });
  grantFindMany.mockImplementation(
    async (args: { where: { group: Record<string, unknown> } }) =>
      args.where.group.tokenMembers ? tokenGrants : userGrants,
  );
}

const environments = {
  resolveEnvId: async () => "env-prod",
  defaultEnvId: async () => "env-prod",
  isDefaultEnv: async () => false, // keeps lifecycle schedule side-effects out of scope
  list: async () => [{ id: "env-prod", isDefault: true }],
} as never;

function graphRow(workflowKey: string, version = 1) {
  return {
    tenantId: "t-1",
    environmentId: "env-prod",
    workflowKey,
    name: workflowKey,
    version,
    graph: { startNodeId: "s", nodes: [], edges: [] },
    contentHash: "hash",
    createdAt: new Date("2026-07-10T00:00:00Z"),
  };
}

function execRow(over: Record<string, unknown> = {}) {
  return {
    workflowId: "run-1",
    tenantId: "t-1",
    workflowKey: "wf-a",
    environmentId: "env-prod",
    status: "completed",
    costUsd: null,
    createdAt: new Date("2026-07-10T00:00:00Z"),
    archivedAt: null,
    graphVersion: 1,
    ...over,
  };
}

interface Harness {
  workflows: V1WorkflowsController;
  runs: V1RunsController;
  signal: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const perms = new PermissionsService(new PermissionsCache());
  const graphs = new GraphsService(perms);
  const executions = new ExecutionsService(
    graphs as never,
    environments,
    perms,
  );
  const signal = vi.fn();
  const terminate = vi.fn();
  (executions as unknown as { client: unknown }).client = {
    workflow: {
      getHandle: () => ({
        signal,
        terminate,
        describe: async () => ({ status: { name: "RUNNING" } }),
        query: async () => ({
          status: "running",
          currentNodeId: "n1",
          ctx: { out: 1 },
        }),
      }),
    },
  };
  // Lifecycle isn't under test beyond its gate; v1 put/delete go through upsert/assert
  // inside GraphsService, so a thin passthrough keeps the harness honest but small.
  const lifecycle = {
    saveWorkflow: (
      t: string,
      e: string,
      k: string,
      n: string,
      g: unknown,
      actor?: Principal,
    ) => graphs.upsert(t, e, k, n, g as never, actor),
  } as never;
  return {
    workflows: new V1WorkflowsController(graphs, environments, lifecycle),
    runs: new V1RunsController(executions, environments),
    signal,
    terminate,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  grantFindFirst.mockResolvedValue(null);
  grantFindMany.mockResolvedValue([]);
  graphFindMany.mockResolvedValue([]);
  graphFindFirst.mockResolvedValue(null);
  activationFindMany.mockResolvedValue([]);
  tagFindMany.mockResolvedValue([]);
  execFindMany.mockResolvedValue([]);
  execFindUnique.mockResolvedValue(execRow());
});

// ---------------------------------------------------------------------------
// GET /v1/workflows — list FILTERING for both subject kinds.
// ---------------------------------------------------------------------------
describe("v1 workflows list filtering", () => {
  it("a restricted MEMBER sees only the keys their groups grant view on", async () => {
    enforce([grant({ canView: true, workflows: [{ workflowKey: "wf-a" }] })]);
    graphFindMany.mockResolvedValue([graphRow("wf-a"), graphRow("wf-b")]);

    const out = await makeHarness().workflows.list(
      "t-1",
      undefined,
      memberUser,
    );
    expect(out.map((w) => w.workflowKey)).toEqual(["wf-a"]);
  });

  it("a restricted TOKEN resolves by tokenId — its own groups, not a user's", async () => {
    enforce(
      [grant({ canView: true, workflows: [{ workflowKey: "wf-a" }] })], // user groups
      [grant({ canRun: true, workflows: [{ workflowKey: "wf-b" }] })], // token groups
    );
    graphFindMany.mockResolvedValue([graphRow("wf-a"), graphRow("wf-b")]);

    const out = await makeHarness().workflows.list(
      "t-1",
      undefined,
      restrictedToken,
    );
    expect(out.map((w) => w.workflowKey)).toEqual(["wf-b"]); // run implies view
  });

  it("zero-grant workspace (the cliff): both subject kinds see everything", async () => {
    grantFindFirst.mockResolvedValue(null);
    graphFindMany.mockResolvedValue([graphRow("wf-a"), graphRow("wf-b")]);
    const h = makeHarness();
    expect(await h.workflows.list("t-1", undefined, memberUser)).toHaveLength(
      2,
    );
    expect(
      await h.workflows.list("t-1", undefined, restrictedToken),
    ).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Single-workflow verbs: 403 on ungranted, 200 on granted.
// ---------------------------------------------------------------------------
describe("v1 workflows verb gating", () => {
  it("GET /v1/workflows/:key — view 403 ungranted, 200 granted", async () => {
    enforce([grant({ canView: true, workflows: [{ workflowKey: "wf-a" }] })]);
    graphFindFirst.mockResolvedValue(graphRow("wf-a"));
    const h = makeHarness();

    await expect(
      h.workflows.get("t-1", "wf-b", undefined, memberUser),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const out = await h.workflows.get("t-1", "wf-a", undefined, memberUser);
    expect(out.workflowKey).toBe("wf-a");
  });

  it("PUT /v1/workflows/:key — a view-only member cannot edit (403 before persist)", async () => {
    enforce([grant({ canView: true, workflows: [{ workflowKey: "wf-a" }] })]);
    graphFindFirst.mockResolvedValue(graphRow("wf-a")); // existing key ⇒ edit verb
    const body = {
      name: "wf-a",
      graph: {
        startNodeId: "s",
        nodes: [
          { id: "s", type: "start" },
          { id: "e", type: "end" },
        ],
        edges: [{ from: "s", to: "e" }],
      },
    };
    await expect(
      makeHarness().workflows.put(
        "t-1",
        "wf-a",
        body as never,
        undefined,
        memberUser,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("POST /v1/workflows/:key/promote — share is its own verb (403 without it)", async () => {
    enforce([
      grant({
        canView: true,
        canRun: true,
        canEdit: true,
        workflows: [{ workflowKey: "wf-a" }],
      }),
    ]);
    await expect(
      makeHarness().workflows.promote(
        "t-1",
        "wf-a",
        { toEnv: "sandbox" } as never,
        memberUser,
        undefined,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ---------------------------------------------------------------------------
// /v1/runs — read scoping + action gating (G3), both subject kinds.
// ---------------------------------------------------------------------------
describe("v1 runs read scoping + action gating", () => {
  it("GET /v1/runs — a restricted token's rows are filtered IN the where clause", async () => {
    enforce(
      [],
      [grant({ canView: true, workflows: [{ workflowKey: "wf-a" }] })],
    );
    execFindMany.mockResolvedValue([execRow()]);

    const out = await makeHarness().runs.list(
      "t-1",
      undefined,
      undefined,
      restrictedToken,
    );

    // The DB never even sees invisible rows: the key filter is part of the query.
    expect(execFindMany.mock.calls[0][0].where.AND).toEqual([
      {
        OR: [
          {
            workflowKey: { in: ["wf-a"] },
            OR: [{ environmentId: "env-prod" }, { environmentId: null }],
          },
        ],
      },
    ]);
    expect(out.items.map((r) => r.runId)).toEqual(["run-1"]);
  });

  it("GET /v1/runs/:id — view 403 for an ungranted member, 200 granted", async () => {
    enforce([grant({ canView: true, workflows: [{ workflowKey: "wf-a" }] })]);
    const h = makeHarness();

    execFindUnique.mockResolvedValue(execRow({ workflowKey: "wf-hidden" }));
    await expect(h.runs.get("t-1", "run-1", memberUser)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    execFindUnique.mockResolvedValue(execRow({ workflowKey: "wf-a" }));
    const out = await h.runs.get("t-1", "run-1", memberUser);
    expect(out).toMatchObject({ runId: "run-1", status: "running" });
  });

  it("GET /v1/runs/:id/history — same view gate for a restricted token", async () => {
    enforce(
      [],
      [grant({ canRun: true, workflows: [{ workflowKey: "wf-a" }] })],
    );
    execFindUnique.mockResolvedValue(execRow({ workflowKey: "wf-hidden" }));
    await expect(
      makeHarness().runs.history("t-1", "run-1", restrictedToken),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("POST /v1/runs/:id/approve — `run` 403 ungranted; granted token signals", async () => {
    enforce(
      [],
      [grant({ canRun: true, workflows: [{ workflowKey: "wf-a" }] })],
    );
    const h = makeHarness();

    execFindUnique.mockResolvedValue(execRow({ workflowKey: "wf-hidden" }));
    await expect(
      h.runs.approve("t-1", "run-1", { approved: true }, restrictedToken),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.signal).not.toHaveBeenCalled();

    execFindUnique.mockResolvedValue(execRow({ workflowKey: "wf-a" }));
    const out = await h.runs.approve(
      "t-1",
      "run-1",
      { approved: true },
      restrictedToken,
    );
    expect(out).toEqual({ accepted: true });
    expect(h.signal).toHaveBeenCalledTimes(1);
  });

  it("POST /v1/runs/:id/cancel — a VIEW-only grant cannot cancel (run ≠ view)", async () => {
    enforce([grant({ canView: true, workflows: [{ workflowKey: "wf-a" }] })]);
    const h = makeHarness();
    execFindUnique.mockResolvedValue(execRow({ workflowKey: "wf-a" }));
    await expect(
      h.runs.cancel("t-1", "run-1", memberUser),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.terminate).not.toHaveBeenCalled();
  });

  it("env-scoped grants apply to runs: a sandbox-only viewer can't open a prod run", async () => {
    enforce([
      grant({
        canView: true,
        environmentId: "env-sandbox",
        workflows: [{ workflowKey: "wf-a" }],
      }),
    ]);
    execFindUnique.mockResolvedValue(
      execRow({ workflowKey: "wf-a", environmentId: "env-prod" }),
    );
    await expect(
      makeHarness().runs.get("t-1", "run-1", memberUser),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("zero-grant workspace: runs routes behave exactly as before for both subjects", async () => {
    grantFindFirst.mockResolvedValue(null);
    execFindMany.mockResolvedValue([execRow()]);
    const h = makeHarness();
    const page = await h.runs.list("t-1", undefined, undefined, memberUser);
    expect(execFindMany.mock.calls[0][0].where).toEqual({
      tenantId: "t-1",
      archivedAt: null,
    });
    expect(page.items).toHaveLength(1);
    await expect(
      h.runs.get("t-1", "run-1", restrictedToken),
    ).resolves.toMatchObject({ runId: "run-1" });
  });
});
