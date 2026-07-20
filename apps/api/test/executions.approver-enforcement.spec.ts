import { beforeEach, describe, expect, it, vi } from "vitest";

// Prisma seams used by the Slice-1 paths: the execution read-model, the RBAC membership
// tables (decide-time enforcement), and TenantSettings (public prompt workspace name).
const findUnique = vi.fn();
const findMany = vi.fn();
const groupMemberFindFirst = vi.fn();
const groupTokenMemberFindFirst = vi.fn();
const tenantSettingsFindUnique = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    execution: { findUnique, findMany },
    groupMember: { findFirst: groupMemberFindFirst },
    groupTokenMember: { findFirst: groupTokenMemberFindFirst },
    tenantSettings: { findUnique: tenantSettingsFindUnique },
  }),
}));

import { ForbiddenException } from "@nestjs/common";
import type { Principal } from "../src/auth/tenant.decorator";
import { ExecutionsService } from "../src/executions/executions.service";

/** Awaiting state with the pause-time record the worker snapshots (ctx.__approval). */
function awaitingState(record?: Record<string, unknown>) {
  return {
    status: "awaiting_approval",
    currentNodeId: "gate",
    ctx: record ? { __approval: record } : {},
  };
}

const ROUTED = {
  nodeId: "gate",
  pausedAt: "2026-07-10T00:00:00.000Z",
  slaHours: 48,
  contextFields: { Company: "Acme", Amount: "$1,200" },
  approvers: {
    emails: ["sam@acme.io"],
    groups: [{ id: "g-finance", name: "finance-leads" }],
  },
  escalateAfterHours: 20,
  escalateTo: "@ops-oncall",
};

function makeService(opts: {
  getLatest?: () => Promise<unknown>;
  query?: () => Promise<unknown>;
  signal?: ReturnType<typeof vi.fn>;
  /** getEffective result — default unrestricted (bypass), so assertRunAccess is a no-op. */
  restricted?: boolean;
}): ExecutionsService {
  const graphs = { getLatest: opts.getLatest ?? (async () => null) } as never;
  const perms = {
    getEffective: async () => ({
      restricted: opts.restricted ?? false,
      canCreate: true,
      view: { all: true, keys: [] },
      run: { all: true, keys: [] },
      edit: { all: true, keys: [] },
      delete: { all: true, keys: [] },
      share: { all: true, keys: [] },
    }),
    assertCan: vi.fn().mockResolvedValue(undefined),
    can: vi.fn().mockResolvedValue(true),
  } as never;
  const service = new ExecutionsService(
    graphs,
    {
      defaultEnvId: async () => "env-default",
      resolveEnvId: async () => "env-default",
    } as never,
    perms,
  );
  (service as unknown as { client: unknown }).client = {
    workflow: {
      getHandle: () => ({
        query: opts.query ?? (async () => awaitingState(ROUTED)),
        signal: opts.signal ?? vi.fn().mockResolvedValue(undefined),
      }),
    },
  };
  return service;
}

const ROW = {
  workflowId: "wf-1",
  tenantId: "t-1",
  workflowKey: "ship",
  environmentId: "env-1",
  createdAt: new Date("2026-07-10T00:00:00Z"),
};

beforeEach(() => {
  findUnique.mockReset().mockResolvedValue(ROW);
  findMany.mockReset().mockResolvedValue([]);
  groupMemberFindFirst.mockReset().mockResolvedValue(null);
  groupTokenMemberFindFirst.mockReset().mockResolvedValue(null);
  tenantSettingsFindUnique.mockReset().mockResolvedValue(null);
});

const member = (over: Partial<Principal> = {}): Principal => ({
  tenantId: "t-1",
  userId: "u-1",
  email: "someone@acme.io",
  role: "member",
  ...over,
});

describe("decide-time approver enforcement (Slice 1)", () => {
  it("no approvers on the gate → existing behavior (member decides fine)", async () => {
    const signal = vi.fn().mockResolvedValue(undefined);
    const service = makeService({
      signal,
      query: async () =>
        awaitingState({ ...ROUTED, approvers: undefined } as never),
    });
    await service.approve("wf-1", true, "t-1", undefined, member());
    expect(signal).toHaveBeenCalledOnce();
  });

  it("run predating the snapshot (no ctx.__approval) → unchanged behavior", async () => {
    const signal = vi.fn().mockResolvedValue(undefined);
    const service = makeService({ signal, query: async () => awaitingState() });
    await service.approve("wf-1", true, "t-1", undefined, member());
    expect(signal).toHaveBeenCalledOnce();
  });

  it("ALLOWS a listed email (case-insensitive) for a member user", async () => {
    const signal = vi.fn().mockResolvedValue(undefined);
    const service = makeService({ signal });
    await service.approve(
      "wf-1",
      true,
      "t-1",
      undefined,
      member({ email: "SAM@ACME.IO" }),
    );
    expect(signal).toHaveBeenCalledOnce();
    // No group lookup needed — the email matched first.
    expect(groupMemberFindFirst).not.toHaveBeenCalled();
  });

  it("ALLOWS a member of a listed group (GroupMember by uid, tenant-scoped)", async () => {
    groupMemberFindFirst.mockResolvedValue({ groupId: "g-finance" });
    const signal = vi.fn().mockResolvedValue(undefined);
    const service = makeService({ signal });
    await service.approve("wf-1", true, "t-1", undefined, member());
    expect(signal).toHaveBeenCalledOnce();
    expect(groupMemberFindFirst).toHaveBeenCalledWith({
      where: {
        userId: "u-1",
        groupId: { in: ["g-finance"] },
        group: { tenantId: "t-1" },
      },
      select: { groupId: true },
    });
  });

  it("ALLOWS a restricted token via GroupTokenMember", async () => {
    groupTokenMemberFindFirst.mockResolvedValue({ groupId: "g-finance" });
    const signal = vi.fn().mockResolvedValue(undefined);
    const service = makeService({ signal });
    await service.approve("wf-1", true, "t-1", undefined, {
      tenantId: "t-1",
      role: "member",
      tokenId: "tok-1",
    });
    expect(signal).toHaveBeenCalledOnce();
    expect(groupTokenMemberFindFirst).toHaveBeenCalledWith({
      where: {
        tokenId: "tok-1",
        groupId: { in: ["g-finance"] },
        group: { tenantId: "t-1" },
      },
      select: { groupId: true },
    });
  });

  it("403s a NON-approver member (clear message, signal never sent)", async () => {
    const signal = vi.fn().mockResolvedValue(undefined);
    const service = makeService({ signal });
    await expect(
      service.approve("wf-1", true, "t-1", undefined, member()),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.approve("wf-1", true, "t-1", undefined, member()),
    ).rejects.toThrow(/restricted to its listed approvers/);
    expect(signal).not.toHaveBeenCalled();
  });

  it("403s an unmatched token in an unenforced workspace (no tokenId → fail closed)", async () => {
    const signal = vi.fn().mockResolvedValue(undefined);
    const service = makeService({ signal });
    await expect(
      service.approve("wf-1", true, "t-1", undefined, {
        tenantId: "t-1",
        role: "owner", // unenforced-workspace token principal — NOT a user
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(signal).not.toHaveBeenCalled();
  });

  it("BYPASSES owner and admin USER principals", async () => {
    for (const role of ["owner", "admin"] as const) {
      const signal = vi.fn().mockResolvedValue(undefined);
      const service = makeService({ signal });
      await service.approve("wf-1", true, "t-1", undefined, member({ role }));
      expect(signal).toHaveBeenCalledOnce();
    }
  });

  it("skips enforcement when the run is no longer awaiting (signal path 409s instead)", async () => {
    const signal = vi.fn().mockResolvedValue(undefined);
    const service = makeService({
      signal,
      query: async () => ({ status: "running", currentNodeId: "x", ctx: {} }),
    });
    await service.approve("wf-1", true, "t-1", undefined, member());
    expect(signal).toHaveBeenCalledOnce(); // enforcement skipped; Temporal decides fate
  });

  it("absent actor (internal caller) is never checked", async () => {
    const signal = vi.fn().mockResolvedValue(undefined);
    const service = makeService({ signal });
    await service.approve("wf-1", true, "t-1");
    expect(signal).toHaveBeenCalledOnce();
  });
});

describe("public prompt (Slice 1 fields)", () => {
  it("returns workspaceName, contextFields, slaHours and the derived dueAt", async () => {
    tenantSettingsFindUnique.mockResolvedValue({ displayName: "Acme Inc" });
    const service = makeService({
      getLatest: async () => ({
        graph: {
          startNodeId: "start",
          nodes: [
            { id: "gate", type: "humanApproval", config: { title: "Ship?" } },
          ],
          edges: [],
        },
      }),
    });
    const out = await service.promptByWorkflowId("wf-1");
    expect(out).toMatchObject({
      awaiting: true,
      title: "Ship?",
      workspaceName: "Acme Inc",
      contextFields: { Company: "Acme", Amount: "$1,200" },
      slaHours: 48,
      // pausedAt 2026-07-10T00:00Z + 48h
      dueAt: "2026-07-12T00:00:00.000Z",
    });
  });

  it("degrades to nulls for a gate without the snapshot (legacy pause)", async () => {
    const service = makeService({
      getLatest: async () => null,
      query: async () => awaitingState(),
    });
    const out = await service.promptByWorkflowId("wf-1");
    expect(out).toMatchObject({
      awaiting: true,
      workspaceName: null,
      contextFields: null,
      slaHours: null,
      dueAt: null,
    });
  });
});

describe("listAwaiting (Slice 1 enrichment)", () => {
  it("rows carry pausedAt/slaHours/dueAt/contextFields/approvers from the snapshot", async () => {
    findMany.mockResolvedValue([{ ...ROW }]);
    const service = makeService({
      getLatest: async () => ({
        graph: {
          startNodeId: "start",
          nodes: [
            { id: "gate", type: "humanApproval", config: { title: "Ship?" } },
          ],
          edges: [],
        },
      }),
    });
    const out = await service.listAwaiting("t-1");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      workflowId: "wf-1",
      nodeId: "gate",
      pausedAt: "2026-07-10T00:00:00.000Z",
      slaHours: 48,
      dueAt: "2026-07-12T00:00:00.000Z",
      contextFields: { Company: "Acme", Amount: "$1,200" },
      approvers: {
        emails: ["sam@acme.io"],
        groups: [{ id: "g-finance", name: "finance-leads" }],
      },
      escalateAfterHours: 20,
      escalateTo: "@ops-oncall",
    });
  });
});

describe("remindContext (manual Remind now)", () => {
  it("returns the run's env + prompt title when awaiting", async () => {
    const service = makeService({
      getLatest: async () => ({
        graph: {
          startNodeId: "start",
          nodes: [
            { id: "gate", type: "humanApproval", config: { title: "Ship?" } },
          ],
          edges: [],
        },
      }),
    });
    const out = await service.remindContext("wf-1", "t-1");
    expect(out).toEqual({
      environmentId: "env-1",
      workflowId: "wf-1",
      workflowKey: "ship",
      title: "Ship?",
    });
  });

  it("409s when the run is no longer awaiting approval", async () => {
    const service = makeService({
      query: async () => ({ status: "completed", currentNodeId: "", ctx: {} }),
    });
    await expect(service.remindContext("wf-1", "t-1")).rejects.toThrow(
      /not awaiting approval/,
    );
  });
});
