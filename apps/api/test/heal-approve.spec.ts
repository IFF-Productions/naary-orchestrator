// Approving a proposed fix — and the two ways that must NOT write.
//
// Approval writes a new workflow version, days after the proposal was generated. In that gap the
// workflow may have been edited by hand. Applying then would silently revert a colleague's work,
// and a self-healing feature that eats someone's edits is worse than one that occasionally asks
// you to run it again. So staleness is re-checked against the LIVE latest at decision time, never
// trusted from proposal time.
import "reflect-metadata";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.hoisted(() => vi.fn());
const findFirst = vi.hoisted(() => vi.fn());
const updateMany = vi.hoisted(() => vi.fn());

vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    workflowFixProposal: { findUnique, updateMany },
    graphDefinition: { findFirst },
  }),
}));

import { HealService } from "../src/heal/heal.service";

const TENANT = "11111111-2222-3333-4444-555555555555";

const PROPOSAL = {
  id: "p-1",
  tenantId: TENANT,
  environmentId: "env-1",
  workflowKey: "pagerduty-triage",
  runId: "exec-1",
  failureSignature: "sig",
  failureSummary: "pagerduty: boom",
  baseVersion: 7,
  proposedGraph: { startNodeId: "s", nodes: [], edges: [] },
  diffSummary: { add: 1, chg: 1, del: 0, total: 2 },
  status: "pending",
  appliedVersion: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** A HealService with just the collaborators the decision path touches. */
function makeService(over: {
  latestVersion?: number | null;
  upsert?: ReturnType<typeof vi.fn>;
}) {
  const upsert = over.upsert ?? vi.fn().mockResolvedValue({ version: 8 });
  const graphs = {
    getLatest: vi
      .fn()
      .mockResolvedValue(
        over.latestVersion == null
          ? null
          : { graph: {}, contentHash: "h", version: over.latestVersion },
      ),
    upsert,
  };
  const svc = new HealService(
    graphs as never,
    {} as never,
    { assertCan: vi.fn() } as never,
  );
  // The Temporal client is only used to signal the parked workflow, which is best-effort.
  (svc as unknown as { client: unknown }).client = {
    workflow: { getHandle: () => ({ signal: vi.fn() }) },
  };
  return { svc, graphs, upsert };
}

beforeEach(() => {
  findUnique.mockReset().mockResolvedValue(PROPOSAL);
  findFirst.mockReset().mockResolvedValue({ name: "PagerDuty Triage" });
  updateMany.mockReset().mockResolvedValue({ count: 1 });
});

describe("approve — the happy path", () => {
  it("writes the proposed graph through the REAL save path", async () => {
    const { svc, upsert } = makeService({ latestVersion: 7 });
    const out = await svc.approve(TENANT, "p-1", {
      email: "ops@corp.com",
    } as never);

    expect(out).toEqual({ status: "applied", appliedVersion: 8 });
    // `upsert` is what enforces the `edit` gate, hashes, versions and stamps savedBy — approval
    // must go through it rather than writing a GraphDefinition row itself.
    expect(upsert).toHaveBeenCalledTimes(1);
    const [tenantId, envId, key, name, graph, actor, message] =
      upsert.mock.calls[0];
    expect(tenantId).toBe(TENANT);
    expect(envId).toBe("env-1");
    expect(key).toBe("pagerduty-triage");
    // The workflow's CURRENT display name, not its key: passing the key would silently rename
    // the workflow to its slug the first time any fix was approved.
    expect(name).toBe("PagerDuty Triage");
    expect(graph).toEqual(PROPOSAL.proposedGraph);
    // The principal is handed on, because THAT is what the save gate authorizes against.
    expect(actor).toMatchObject({ email: "ops@corp.com" });
    expect(message).toContain("exec-1");
  });
});

describe("approve — what must NOT write", () => {
  it("refuses when the workflow has moved on, and marks the proposal stale", async () => {
    // The core safety property. Someone edited the workflow to v9 while the proposal sat.
    const { svc, upsert } = makeService({ latestVersion: 9 });

    await expect(svc.approve(TENANT, "p-1")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(upsert).not.toHaveBeenCalled();

    // …and it does not linger as pending, which would let a later click try again on a proposal
    // that can never be right.
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "p-1", status: "pending" },
        data: expect.objectContaining({ status: "stale" }),
      }),
    );
  });

  it("refuses when the workflow is gone", async () => {
    const { svc, upsert } = makeService({ latestVersion: null });
    await expect(svc.approve(TENANT, "p-1")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses a proposal that was already decided", async () => {
    // Two reviewers clicking at once must not produce two versions from one proposal.
    findUnique.mockResolvedValue({ ...PROPOSAL, status: "applied" });
    const { svc, upsert } = makeService({ latestVersion: 7 });
    await expect(svc.approve(TENANT, "p-1")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it("404s another tenant's proposal, without revealing it exists", async () => {
    findUnique.mockResolvedValue({ ...PROPOSAL, tenantId: "someone-else" });
    const { svc, upsert } = makeService({ latestVersion: 7 });
    // NotFound, not Forbidden: a proposal belonging to another workspace must be
    // indistinguishable from one that never existed.
    await expect(svc.approve(TENANT, "p-1")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("reject", () => {
  it("closes the proposal and never writes a version", async () => {
    const { svc, upsert } = makeService({ latestVersion: 7 });
    const out = await svc.reject(TENANT, "p-1", {
      email: "ops@corp.com",
    } as never);
    expect(out).toEqual({ status: "rejected" });
    expect(upsert).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "p-1", status: "pending" },
        data: expect.objectContaining({
          status: "rejected",
          decidedBy: "ops@corp.com",
        }),
      }),
    );
  });
});
