import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowNotFoundError } from "@temporalio/client";
import { APPROVAL_CTX_KEY } from "@naary/contracts";

/**
 * #1053 — removing a member strands the paused runs that named them as approver.
 *
 * A `humanApproval` gate freezes its approver routing into `ctx.__approval` at pause time and
 * never re-reads it, so a removal can leave a compliance gate with nobody able to decide it —
 * and with no `timeoutHours` the run parks FOREVER. The decision (carried from #1041/#1054) is
 * to SURFACE it and never auto-decide: a run must not report a decision no human made.
 *
 * What this file pins:
 *  1. a removal that strands a run reports it, and one that strands nothing reports nothing;
 *  2. the EMAIL/GROUP asymmetry — an email list is frozen, but group membership is resolved
 *     LIVE at decide time, so a group-routed gate with anyone else still in the group is NOT
 *     stranded. Counting those would make the banner fire on nearly every removal;
 *  3. the removal still SUCCEEDS when the approval lookup fails (Temporal unreachable). This is
 *     the ordering invariant: the delete commits BEFORE anything reads Temporal, so a workflow
 *     service outage can never block de-provisioning.
 *
 * The prisma double is stateful, like members.removal-leaks.spec.ts, so the assertions can be
 * about END STATE (the membership is gone) rather than about which mocks were called.
 */

interface MembershipRow {
  userId: string;
  tenantId: string;
  role: string;
  email: string | null;
  createdAt: Date;
  lastActiveAt: Date | null;
}
interface GroupMemberRow {
  groupId: string;
  userId: string;
}
interface ExecutionRow {
  workflowId: string;
  workflowKey: string | null;
  tenantId: string;
  status: string;
  createdAt: Date;
}

const db = {
  memberships: [] as MembershipRow[],
  groupMembers: [] as GroupMemberRow[],
  /** groupId → tenantId (the `group: { tenantId }` relation filter). */
  groupTenant: new Map<string, string>(),
  executions: [] as ExecutionRow[],
};

/** `{ in: [...], mode: "insensitive" }` — the only string filter these reads use. */
function inInsensitive(filter: any, value: string | null): boolean {
  const list: string[] = filter?.in ?? [];
  return list.some((v) => v.toLowerCase() === (value ?? "").toLowerCase());
}

const prisma = {
  $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  membership: {
    findUnique: async ({ where }: any) => {
      const { userId, tenantId } = where.userId_tenantId;
      return (
        db.memberships.find(
          (m) => m.userId === userId && m.tenantId === tenantId,
        ) ?? null
      );
    },
    findMany: async ({ where }: any) =>
      db.memberships
        .filter(
          (m) =>
            m.tenantId === where.tenantId &&
            (where.email ? inInsensitive(where.email, m.email) : true),
        )
        .map((m) => ({ email: m.email })),
    count: async ({ where }: any) =>
      db.memberships.filter(
        (m) => m.tenantId === where.tenantId && m.role === where.role,
      ).length,
    deleteMany: async ({ where }: any) => {
      const before = db.memberships.length;
      db.memberships = db.memberships.filter(
        (m) => !(m.userId === where.userId && m.tenantId === where.tenantId),
      );
      return { count: before - db.memberships.length };
    },
  },
  groupMember: {
    findMany: async ({ where }: any) =>
      db.groupMembers
        .filter((gm) => {
          if (where.userId !== undefined && gm.userId !== where.userId) {
            return false;
          }
          if (
            where.groupId?.in !== undefined &&
            !where.groupId.in.includes(gm.groupId)
          ) {
            return false;
          }
          return db.groupTenant.get(gm.groupId) === where.group?.tenantId;
        })
        .map((gm) => ({ groupId: gm.groupId })),
    deleteMany: async ({ where }: any) => {
      const before = db.groupMembers.length;
      db.groupMembers = db.groupMembers.filter(
        (gm) =>
          !(
            gm.userId === where.userId &&
            db.groupTenant.get(gm.groupId) === where.group?.tenantId
          ),
      );
      return { count: before - db.groupMembers.length };
    },
  },
  execution: {
    findMany: async ({ where, take }: any) =>
      db.executions
        .filter(
          (e) => e.tenantId === where.tenantId && e.status === where.status,
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, take)
        .map((e) => ({ workflowId: e.workflowId, workflowKey: e.workflowKey })),
  },
  invitation: { findFirst: async () => null, findUnique: async () => null },
  tenantSettings: { findUnique: async () => null },
};

vi.mock("@naary/db", () => ({ getPrisma: () => prisma }));

import type { Principal } from "../src/auth/tenant.decorator";
import type { AuditService } from "../src/audit/audit.service";
import { ExecutionsService } from "../src/executions/executions.service";
import type { MailerService } from "../src/mail/mailer.service";
import type { MembershipService } from "../src/membership/membership.service";
import { MembersService } from "../src/members/members.service";
import type { PermissionsService } from "../src/permissions/permissions.service";

/** workflowId → the ExecutionState a `stateQuery` answers with; absent ⇒ WorkflowNotFoundError
 *  (a history that is genuinely gone — a FACT about that run, not a service problem). */
const states = new Map<string, unknown>();
/** Simulates the SERVICE being down: every query fails with a transport error. */
let queryFails = false;

const client = {
  workflow: {
    getHandle: (workflowId: string) => ({
      query: async () => {
        if (queryFails) throw new Error("Temporal is unreachable");
        const s = states.get(workflowId);
        if (!s) {
          throw new WorkflowNotFoundError("gone", workflowId, undefined);
        }
        return s;
      },
    }),
  },
};

const auditRecord = vi.fn().mockResolvedValue(undefined);
const executions = new ExecutionsService(
  {} as never,
  {} as never,
) as ExecutionsService;
// The service connects to Temporal in onModuleInit, which never runs here — hand it the double.
(executions as unknown as { client: unknown }).client = client;

const svc = new MembersService(
  { invalidate: vi.fn() } as unknown as MembershipService,
  { sendInvitation: vi.fn() } as unknown as MailerService,
  { invalidateTenant: vi.fn() } as unknown as PermissionsService,
  executions,
  { record: auditRecord } as unknown as AuditService,
);

const asOwner: Principal = { tenantId: "t-1", userId: "u-own", role: "owner" };

/** A paused run whose frozen snapshot routes to `emails` / `groups`. */
function pausedRun(
  workflowId: string,
  approvers: { emails?: string[]; groups?: { id: string; name: string }[] },
  workflowKey = "wf-invoice",
): void {
  db.executions.push({
    workflowId,
    workflowKey,
    tenantId: "t-1",
    status: "awaiting_approval",
    createdAt: new Date(),
  });
  states.set(workflowId, {
    status: "awaiting_approval",
    currentNodeId: "approve-1",
    ctx: {
      [APPROVAL_CTX_KEY]: {
        nodeId: "approve-1",
        pausedAt: "2026-01-01T00:00:00.000Z",
        approvers: {
          emails: approvers.emails ?? [],
          groups: approvers.groups ?? [],
        },
      },
    },
  });
}

beforeEach(() => {
  db.memberships = [
    {
      userId: "u-kim",
      tenantId: "t-1",
      role: "member",
      email: "Kim@acme.com",
      createdAt: new Date(),
      lastActiveAt: null,
    },
    {
      userId: "u-own",
      tenantId: "t-1",
      role: "owner",
      email: "own@acme.com",
      createdAt: new Date(),
      lastActiveAt: null,
    },
    {
      userId: "u-sam",
      tenantId: "t-1",
      role: "member",
      email: "sam@acme.com",
      createdAt: new Date(),
      lastActiveAt: null,
    },
  ];
  db.groupMembers = [];
  db.groupTenant = new Map([
    ["g-finance", "t-1"],
    ["g-solo", "t-1"],
  ]);
  db.executions = [];
  states.clear();
  queryFails = false;
  auditRecord.mockClear();
});

describe("removeMember surfaces the approvals it strands (#1053)", () => {
  it("reports an EMAIL-routed gate the removed member was the only approver on", async () => {
    pausedRun("run-a", { emails: ["kim@acme.com"] });

    const res = await svc.removeMember("t-1", asOwner, "u-kim");

    expect(res.removed).toBe(true);
    expect(res.strandedApprovals.total).toBe(1);
    expect(res.strandedApprovals.needsOwnerOrAdmin).toBe(1);
    expect(res.strandedApprovals.partial).toBe(false);
    expect(res.strandedApprovals.runs).toEqual([
      {
        workflowId: "run-a",
        workflowKey: "wf-invoice",
        nodeId: "approve-1",
        needsOwnerOrAdmin: true,
      },
    ]);
    // The membership really is gone — this is a REPORT, not a veto.
    expect(db.memberships.some((m) => m.userId === "u-kim")).toBe(false);
  });

  it("reports NOTHING when no paused run named them", async () => {
    pausedRun("run-a", { emails: ["sam@acme.com"] });

    const res = await svc.removeMember("t-1", asOwner, "u-kim");

    expect(res.strandedApprovals).toEqual({
      total: 0,
      needsOwnerOrAdmin: 0,
      partial: false,
      runs: [],
    });
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("counts a gate that still has a live co-approver, but does NOT call it stranded", async () => {
    // sam@ is still a member, so this gate is decidable by its own listed approver.
    pausedRun("run-a", { emails: ["kim@acme.com", "sam@acme.com"] });

    const res = await svc.removeMember("t-1", asOwner, "u-kim");

    expect(res.strandedApprovals.total).toBe(1);
    expect(res.strandedApprovals.needsOwnerOrAdmin).toBe(0);
    expect(res.strandedApprovals.runs[0].needsOwnerOrAdmin).toBe(false);
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("a GROUP-routed gate with someone else left in the group is not stranded", async () => {
    // The snapshot freezes group IDS only; decide-time resolves membership live — so the gate
    // is still decidable by sam, and un-strands itself if anyone is added later.
    db.groupMembers = [
      { groupId: "g-finance", userId: "u-kim" },
      { groupId: "g-finance", userId: "u-sam" },
    ];
    pausedRun("run-a", { groups: [{ id: "g-finance", name: "Finance" }] });

    const res = await svc.removeMember("t-1", asOwner, "u-kim");

    expect(res.strandedApprovals.total).toBe(1);
    expect(res.strandedApprovals.needsOwnerOrAdmin).toBe(0);
  });

  it("a GROUP-routed gate they were the LAST member of IS stranded", async () => {
    db.groupMembers = [{ groupId: "g-solo", userId: "u-kim" }];
    pausedRun("run-a", { groups: [{ id: "g-solo", name: "Solo" }] });

    const res = await svc.removeMember("t-1", asOwner, "u-kim");

    expect(res.strandedApprovals.total).toBe(1);
    expect(res.strandedApprovals.needsOwnerOrAdmin).toBe(1);
    // Their own group row must not count as an approver still standing — it is deleted with
    // them, and the resolution deliberately runs AFTER the delete for exactly this reason.
    expect(db.groupMembers).toEqual([]);
  });

  it("skips runs that are no longer awaiting, and gates with no approver routing", async () => {
    pausedRun("run-decided", { emails: ["kim@acme.com"] });
    states.set("run-decided", {
      status: "running",
      currentNodeId: "n2",
      ctx: {},
    });
    pausedRun("run-unrouted", {}); // a plain gate names nobody
    pausedRun("run-gone", { emails: ["kim@acme.com"] });
    states.delete("run-gone"); // query throws → closed/gone

    const res = await svc.removeMember("t-1", asOwner, "u-kim");

    expect(res.strandedApprovals.total).toBe(0);
    expect(res.strandedApprovals.partial).toBe(false);
  });

  it("writes an AuditEvent — the surface a SCIM/directory-sync caller still lands in", async () => {
    pausedRun("run-a", { emails: ["kim@acme.com"] });

    await svc.removeMember("t-1", asOwner, "u-kim");

    expect(auditRecord).toHaveBeenCalledTimes(1);
    const ev = auditRecord.mock.calls[0][0];
    expect(ev.tenantId).toBe("t-1");
    expect(ev.method).toBe("DELETE");
    expect(ev.path).toBe("/tenants/t-1/members/u-kim");
    expect(ev.action).toMatch(
      /1 paused approval that now need an owner or admin/,
    );
  });

  it("more paused runs than the scan cap ⇒ the counts are flagged a LOWER BOUND", async () => {
    // 101 > SCAN_MAX (100), so one run is never looked at. The scan must not pretend
    // otherwise — this is the "many paused runs" bound, stated in the response.
    for (let i = 0; i < 101; i++) {
      pausedRun(`run-${i}`, { emails: ["kim@acme.com"] });
    }

    const res = await svc.removeMember("t-1", asOwner, "u-kim");

    expect(res.strandedApprovals.total).toBe(100);
    expect(res.strandedApprovals.partial).toBe(true);
    expect(res.strandedApprovals.runs).toHaveLength(20); // body cap; the counts stay whole
  });

  it("an unknown uid removes nothing and reports nothing", async () => {
    pausedRun("run-a", { emails: ["kim@acme.com"] });

    const res = await svc.removeMember("t-1", asOwner, "u-nobody");

    expect(res.removed).toBe(false);
    expect(res.strandedApprovals.total).toBe(0);
    expect(res.strandedApprovals.partial).toBe(false);
    expect(db.memberships).toHaveLength(3);
  });
});

describe("the removal still succeeds when the approval lookup fails", () => {
  it("Temporal unreachable → the member is REMOVED, the report says 'could not check'", async () => {
    pausedRun("run-a", { emails: ["kim@acme.com"] });
    queryFails = true;

    const res = await svc.removeMember("t-1", asOwner, "u-kim");

    // The whole point of doing the read AFTER the delete: an outage in the workflow service
    // must never be able to keep a de-provisioned user's membership alive.
    expect(res.removed).toBe(true);
    expect(db.memberships.some((m) => m.userId === "u-kim")).toBe(false);
    // …and it must not report a clean removal it never verified.
    expect(res.strandedApprovals.partial).toBe(true);
    expect(res.strandedApprovals.needsOwnerOrAdmin).toBe(0);
  });

  it("the whole lookup throwing → still removed, still partial", async () => {
    pausedRun("run-a", { emails: ["kim@acme.com"] });
    const boom = vi
      .spyOn(executions, "heldApprovals")
      .mockRejectedValue(new Error("boom"));

    const res = await svc.removeMember("t-1", asOwner, "u-kim");

    expect(res.removed).toBe(true);
    expect(db.memberships.some((m) => m.userId === "u-kim")).toBe(false);
    expect(res.strandedApprovals.partial).toBe(true);
    // "could not check" is itself worth an audit line on the no-human path.
    expect(auditRecord).toHaveBeenCalledTimes(1);
    expect(auditRecord.mock.calls[0][0].action).toMatch(/not fully checked/);
    boom.mockRestore();
  });
});
