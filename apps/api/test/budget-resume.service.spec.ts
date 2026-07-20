// Resume delivery for budget pause-not-fail (Slice 3): PUT-resume enumeration +
// the month-rollover boot reconcile, both batched + best-effort.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  signal: vi.fn(),
  getHandle: vi.fn(),
  connectTemporal: vi.fn(),
}));

vi.mock("@naary/db", () => ({
  getPrisma: () => ({ execution: { findMany: m.findMany } }),
}));
vi.mock("../src/temporal/client", () => ({
  connectTemporal: m.connectTemporal,
}));

import { budgetResumeSignal } from "@naary/contracts";
import { BudgetResumeService } from "../src/budget/budget-resume.service";

function makeService(): Promise<BudgetResumeService> {
  const svc = new BudgetResumeService();
  return svc.onModuleInit().then(() => svc);
}

beforeEach(() => {
  m.findMany.mockReset();
  m.signal.mockReset().mockResolvedValue(undefined);
  m.getHandle.mockReset().mockImplementation((id: string) => ({
    id,
    signal: (...a: unknown[]) => m.signal(id, ...a),
  }));
  m.connectTemporal.mockReset().mockResolvedValue({
    client: { workflow: { getHandle: m.getHandle } },
    connection: { close: vi.fn() },
  });
});

describe("BudgetResumeService.resumeTenant (PUT-resume)", () => {
  it("enumerates the tenant's awaiting_budget rows from the READ MODEL and signals each", async () => {
    m.findMany.mockResolvedValue([
      { workflowId: "wf-a" },
      { workflowId: "wf-b" },
    ]);
    const svc = await makeService();

    const r = await svc.resumeTenant("t1");

    expect(m.findMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", status: "awaiting_budget" },
      select: { workflowId: true },
    });
    expect(r.signaled).toBe(2);
    // tenantId-ONLY payload (no secrets, no budget figures).
    expect(m.signal).toHaveBeenCalledWith("wf-a", budgetResumeSignal, {
      tenantId: "t1",
    });
    expect(m.signal).toHaveBeenCalledWith("wf-b", budgetResumeSignal, {
      tenantId: "t1",
    });
  });

  it("is BEST-EFFORT: one closed/gone run does not stop the rest (logged, not thrown)", async () => {
    m.findMany.mockResolvedValue([
      { workflowId: "wf-gone" },
      { workflowId: "wf-live" },
    ]);
    m.signal.mockImplementation((id: string) =>
      id === "wf-gone"
        ? Promise.reject(new Error("workflow not found"))
        : Promise.resolve(),
    );
    const svc = await makeService();

    const r = await svc.resumeTenant("t1");
    expect(r.signaled).toBe(1);
    expect(m.signal).toHaveBeenCalledTimes(2);
  });

  it("never throws — a PG failure yields {signaled:0} (a budget save must not fail)", async () => {
    m.findMany.mockRejectedValue(new Error("pg down"));
    const svc = await makeService();
    await expect(svc.resumeTenant("t1")).resolves.toEqual({ signaled: 0 });
  });

  it("no paused runs → no signals", async () => {
    m.findMany.mockResolvedValue([]);
    const svc = await makeService();
    expect(await svc.resumeTenant("t1")).toEqual({ signaled: 0 });
    expect(m.signal).not.toHaveBeenCalled();
  });
});

describe("BudgetResumeService.reconcileMonthRollover (boot)", () => {
  it("targets awaiting_budget rows paused BEFORE the current UTC month (NULL included defensively)", async () => {
    m.findMany.mockResolvedValue([
      { workflowId: "wf-old", tenantId: "t1" },
      { workflowId: "wf-null", tenantId: "t2" },
    ]);
    const svc = await makeService();

    const r = await svc.reconcileMonthRollover();

    const where = m.findMany.mock.calls[0][0].where as {
      status: string;
      OR: unknown[];
    };
    expect(where.status).toBe("awaiting_budget");
    const now = new Date();
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    expect(where.OR).toEqual([
      { budgetPausedAt: { lt: monthStart } },
      { budgetPausedAt: null },
    ]);
    expect(r.signaled).toBe(2);
    // Each signal carries ITS OWN tenant id.
    expect(m.signal).toHaveBeenCalledWith("wf-old", budgetResumeSignal, {
      tenantId: "t1",
    });
    expect(m.signal).toHaveBeenCalledWith("wf-null", budgetResumeSignal, {
      tenantId: "t2",
    });
  });

  it("never throws at boot — a Temporal/PG failure logs and reports 0", async () => {
    m.findMany.mockRejectedValue(new Error("boom"));
    const svc = await makeService();
    await expect(svc.reconcileMonthRollover()).resolves.toEqual({
      signaled: 0,
    });
  });
});

describe("BudgetService.set → resume delivery", () => {
  it("a budget PUT fires resumeTenant for that tenant (fire-and-forget)", async () => {
    // In-module import to avoid hoisting the @naary/usage mock over other suites.
    vi.doMock("@naary/usage", () => ({
      getBudget: vi.fn(),
      monthToDateSpend: vi.fn(),
      setBudget: vi.fn().mockResolvedValue({ tenantId: "t9" }),
    }));
    const { BudgetService } = await import("../src/budget/budget.service.js");
    const resume = { resumeTenant: vi.fn().mockResolvedValue({ signaled: 1 }) };

    const saved = await new BudgetService(resume as never).set("t9", {
      monthlyCapUsd: 10,
      perExecutionCapUsd: 1,
    });

    expect(saved).toEqual({ tenantId: "t9" });
    expect(resume.resumeTenant).toHaveBeenCalledWith("t9");
    vi.doUnmock("@naary/usage");
  });
});
