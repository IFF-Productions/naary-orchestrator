import { beforeEach, describe, expect, it, vi } from "vitest";

// Gated cost insights (RBAC G3, user decision: FILTER-to-viewable): getUsage/getInsights
// gain an optional trailing actor. Restricted subjects see only ledger events of workflows
// they can VIEW — filtered through the SAME EnvViewTerm semantics as the runs list
// (default-env owns NULL-environmentId rows; NULL-workflowKey events are unrestricted-only).
// Unrestricted / absent actors keep the query AND the result byte-identical (asserted).

const usageEvent = { findMany: vi.fn() };
const execution = { findMany: vi.fn() };
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ usageEvent, execution }),
}));

import type { Principal } from "../src/auth/tenant.decorator";
import type {
  EnvViewTerm,
  PermissionsService,
} from "../src/permissions/permissions.service";
import { UsageService } from "../src/usage/usage.service";

const member: Principal = { tenantId: "t-1", userId: "u-1", role: "member" };

function perms(termsByCall: EnvViewTerm[] | null) {
  return {
    viewTerms: vi.fn().mockResolvedValue(termsByCall),
  };
}

function makeService(p: ReturnType<typeof perms> | undefined): UsageService {
  return new UsageService(p as unknown as PermissionsService);
}

/** A ledger row. env-prod is the tenant DEFAULT in these specs. */
const ev = (over: Record<string, unknown> = {}) => ({
  id: "e-1",
  executionId: "x-1",
  nodeId: "agent",
  provider: "anthropic",
  model: "sonnet",
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  costUsd: "0.100000",
  environmentId: "env-prod",
  createdAt: new Date("2026-07-16T10:00:00Z"),
  ...over,
});

/** Terms: in env-prod (default) only wf-a is viewable; env-sbx is view-all. */
const TERMS: EnvViewTerm[] = [
  {
    environmentId: "env-prod",
    includesNullEnv: true,
    view: { all: false, keys: ["wf-a"] },
  },
  {
    environmentId: "env-sbx",
    includesNullEnv: false,
    view: { all: true, keys: [] },
  },
];

const LEDGER = [
  ev({ id: "e-1", executionId: "x-a", environmentId: "env-prod" }), // wf-a prod → visible
  ev({ id: "e-2", executionId: "x-b", environmentId: "env-prod" }), // wf-b prod → hidden
  ev({ id: "e-3", executionId: "x-b", environmentId: "env-sbx" }), // wf-b sbx (view-all) → visible
  ev({ id: "e-4", executionId: "x-a", environmentId: null }), // NULL env = default env → wf-a → visible
  ev({ id: "e-5", executionId: "x-none", environmentId: "env-prod" }), // no Execution row → NULL key → hidden
  ev({ id: "e-6", executionId: "x-null", environmentId: "env-sbx" }), // Execution row with NULL key → hidden
];

const EXECS = [
  { workflowId: "x-a", workflowKey: "wf-a" },
  { workflowId: "x-b", workflowKey: "wf-b" },
  { workflowId: "x-null", workflowKey: null },
];

/** Execution rows for the Slice-2 run-outcome rollup (the SECOND findMany getInsights
 *  issues — where {tenantId}, not the workflowId-in join). Same RBAC semantics as the
 *  ledger: wf-b in env-prod is hidden from the TERMS-restricted member. */
const EXEC_RUN_ROWS = [
  {
    workflowKey: "wf-a",
    environmentId: "env-prod",
    status: "completed",
    createdAt: new Date("2026-07-16T10:00:00Z"),
    finishedAt: new Date("2026-07-16T10:00:10Z"),
    failureKind: null,
  },
  {
    // hidden for the restricted member (wf-b in the default env)
    workflowKey: "wf-b",
    environmentId: "env-prod",
    status: "failed",
    createdAt: new Date("2026-07-16T11:00:00Z"),
    finishedAt: null,
    failureKind: "timeout",
  },
  {
    // visible (env-sbx is view-all)
    workflowKey: "wf-b",
    environmentId: "env-sbx",
    status: "completed",
    createdAt: new Date("2026-07-16T12:00:00Z"),
    finishedAt: null,
    failureKind: null,
  },
];

/** getInsights issues TWO execution.findMany calls: the exec→key JOIN (where.workflowId)
 *  and the Slice-2 run-rollup read (where.tenantId). Route each to its fixture. */
function mockExecutionFindMany(
  joinRows: unknown[] = EXECS,
  runRows: unknown[] = EXEC_RUN_ROWS,
) {
  execution.findMany.mockImplementation(
    async (args?: { where?: { workflowId?: unknown } }) =>
      args?.where?.workflowId ? joinRows : runRows,
  );
}

beforeEach(() => {
  usageEvent.findMany.mockReset().mockResolvedValue([]);
  execution.findMany.mockReset().mockResolvedValue([]);
});

describe("UsageService.getUsage RBAC filtering", () => {
  it("a RESTRICTED member sees only viewable events in totals, byModel and the line items", async () => {
    usageEvent.findMany.mockResolvedValue(LEDGER);
    execution.findMany.mockResolvedValue(EXECS);
    const p = perms(TERMS);
    const out = await makeService(p).getUsage(
      "t-1",
      undefined,
      undefined,
      member,
    );

    expect(p.viewTerms).toHaveBeenCalledWith(member, "t-1");
    // e-1, e-3, e-4 survive: default-env null row counts, null-key rows never do.
    expect(out.events.map((e) => e.id)).toEqual(["e-1", "e-3", "e-4"]);
    expect(out.totalCostUsd).toBeCloseTo(0.3, 9);
    expect(out.totalTokens).toBe(450);
    expect(out.byModel[0].calls).toBe(3);
    // The key join ran over the DISTINCT execIds of the fetched rows.
    expect(execution.findMany).toHaveBeenCalledWith({
      where: { workflowId: { in: ["x-a", "x-b", "x-none", "x-null"] } },
      select: { workflowId: true, workflowKey: true },
    });
  });

  it("an UNRESTRICTED actor (viewTerms → null) is byte-identical: same query, no exec join, full result", async () => {
    usageEvent.findMany.mockResolvedValue(LEDGER);
    const out = await makeService(perms(null)).getUsage(
      "t-1",
      undefined,
      undefined,
      member,
    );
    expect(usageEvent.findMany).toHaveBeenCalledWith({
      where: { tenantId: "t-1" },
      orderBy: { createdAt: "desc" },
    });
    expect(execution.findMany).not.toHaveBeenCalled();
    expect(out.events).toHaveLength(6); // null-key events included for unrestricted
  });

  it("an ABSENT actor (company rollup / legacy callers) never consults permissions", async () => {
    usageEvent.findMany.mockResolvedValue(LEDGER);
    const p = perms(TERMS);
    const out = await makeService(p).getUsage("t-1");
    expect(p.viewTerms).not.toHaveBeenCalled();
    expect(out.events).toHaveLength(6);
  });

  it("fails CLOSED when an actor is passed but permissions are not wired", async () => {
    await expect(
      makeService(undefined).getUsage("t-1", undefined, undefined, member),
    ).rejects.toThrow(/PermissionsService is not wired/);
    expect(usageEvent.findMany).not.toHaveBeenCalled();
  });

  it("terms [] (restricted, nothing viewable anywhere) yields an EMPTY summary", async () => {
    usageEvent.findMany.mockResolvedValue(LEDGER);
    execution.findMany.mockResolvedValue(EXECS);
    const out = await makeService(perms([])).getUsage(
      "t-1",
      undefined,
      undefined,
      member,
    );
    expect(out.events).toEqual([]);
    expect(out.totalCostUsd).toBe(0);
    expect(out.byModel).toEqual([]);
  });
});

describe("UsageService.getInsights RBAC filtering", () => {
  it("filters BEFORE the rollup: totals, byDay, byEnvironment and byWorkflow reflect only the viewable slice", async () => {
    usageEvent.findMany.mockResolvedValue(LEDGER);
    mockExecutionFindMany();
    const out = await makeService(perms(TERMS)).getInsights("t-1", {}, member);

    expect(out.totals).toEqual({ costUsd: 0.3, totalTokens: 450, calls: 3 });
    expect(out.byWorkflow.map((w) => w.workflowKey).sort()).toEqual([
      "wf-a",
      "wf-b",
    ]);
    // wf-a: e-1 + e-4 (the default-env null row); wf-b: only its sandbox event.
    expect(out.byWorkflow.find((w) => w.workflowKey === "wf-a")?.calls).toBe(2);
    expect(out.byWorkflow.find((w) => w.workflowKey === "wf-b")?.calls).toBe(1);
    // The hidden null-key bucket never appears for a restricted subject.
    expect(out.byWorkflow.some((w) => w.workflowKey === null)).toBe(false);
    expect(out.byDay).toEqual([
      { date: "2026-07-16", costUsd: 0.3, totalTokens: 450, calls: 3 },
    ]);
    expect(out.byEnvironment.map((e) => e.environmentId).sort()).toEqual(
      [null, "env-prod", "env-sbx"].sort(),
    );
    // Slice 2: the run-outcome rollup is view-filtered with the SAME terms —
    // the hidden wf-b prod failure (and its failureKind) never leaks.
    expect(out.runsByDay).toEqual([
      { date: "2026-07-16", total: 2, byStatus: { completed: 2 } },
    ]);
    expect(out.failureKinds).toEqual([]);
    expect(out.runsByWorkflow).toEqual([
      { workflowKey: "wf-a", runs: 1, avgDurationMs: 10_000 },
      { workflowKey: "wf-b", runs: 1, avgDurationMs: null },
    ]);
  });

  it("an UNRESTRICTED actor's rollup is unchanged (same where, null-key bucket intact)", async () => {
    usageEvent.findMany.mockResolvedValue(LEDGER);
    mockExecutionFindMany();
    const out = await makeService(perms(null)).getInsights("t-1", {}, member);
    expect(usageEvent.findMany).toHaveBeenCalledWith({
      where: { tenantId: "t-1" },
      orderBy: { createdAt: "asc" },
    });
    expect(out.totals.calls).toBe(6);
    expect(out.byWorkflow.some((w) => w.workflowKey === null)).toBe(true);
    // Slice 2: unrestricted sees every run — incl. the classified failure.
    expect(out.runsByDay[0].total).toBe(3);
    expect(out.failureKinds).toEqual([{ kind: "timeout", count: 1 }]);
  });

  it("the explicit ?environmentId filter composes with the RBAC filter (query unchanged)", async () => {
    usageEvent.findMany.mockResolvedValue([
      ev({ id: "e-2", executionId: "x-b", environmentId: "env-prod" }),
    ]);
    mockExecutionFindMany(EXECS, []);
    const out = await makeService(perms(TERMS)).getInsights(
      "t-1",
      { environmentId: "env-prod" },
      member,
    );
    expect(usageEvent.findMany).toHaveBeenCalledWith({
      where: { tenantId: "t-1", environmentId: "env-prod" },
      orderBy: { createdAt: "asc" },
    });
    expect(out.totals.calls).toBe(0); // wf-b isn't viewable in prod
  });

  it("fails CLOSED when an actor is passed but permissions are not wired", async () => {
    await expect(
      makeService(undefined).getInsights("t-1", {}, member),
    ).rejects.toThrow(/PermissionsService is not wired/);
  });
});
