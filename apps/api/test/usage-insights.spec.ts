import { beforeEach, describe, expect, it, vi } from "vitest";

const usageEvent = { findMany: vi.fn() };
const execution = { findMany: vi.fn() };

vi.mock("@naary/db", () => ({
  getPrisma: () => ({ usageEvent, execution }),
}));

// The real aggregateInsights (from @naary/usage) runs — this exercises service + pure rollup together.
import { UsageController } from "../src/usage/usage.controller";
import { UsageService } from "../src/usage/usage.service";

const svc = new UsageService();

beforeEach(() => {
  usageEvent.findMany.mockReset();
  execution.findMany.mockReset();
});

describe("UsageService.getInsights", () => {
  it("scopes to the tenant, joins execs → workflowKey, and rolls up", async () => {
    usageEvent.findMany.mockResolvedValue([
      {
        executionId: "x1",
        environmentId: "prod",
        provider: "anthropic",
        model: "sonnet",
        totalTokens: 100,
        costUsd: 0.1,
        createdAt: "2026-07-16T10:00:00.000Z",
      },
      {
        executionId: "x2",
        environmentId: "prod",
        provider: "openai",
        model: "gpt",
        totalTokens: 50,
        costUsd: 0.2,
        createdAt: "2026-07-16T12:00:00.000Z",
      },
    ]);
    // getInsights issues TWO execution.findMany calls: the exec→key join and the
    // Slice-2 run-outcome rollup (where.tenantId) — route each to its fixture.
    execution.findMany.mockImplementation(
      async (args?: { where?: { workflowId?: unknown } }) =>
        args?.where?.workflowId
          ? [
              { workflowId: "x1", workflowKey: "triage" },
              { workflowId: "x2", workflowKey: "summarize" },
            ]
          : [
              {
                workflowKey: "triage",
                environmentId: "prod",
                status: "completed",
                createdAt: new Date("2026-07-16T10:00:00Z"),
                finishedAt: new Date("2026-07-16T10:00:05Z"),
                failureKind: null,
              },
            ],
    );

    const out = await svc.getInsights("t-1", {});

    // No window / no env filter → where is just the tenant.
    expect(usageEvent.findMany).toHaveBeenCalledWith({
      where: { tenantId: "t-1" },
      orderBy: { createdAt: "asc" },
    });
    // Only the distinct execIds are looked up for the workflowKey join.
    expect(execution.findMany).toHaveBeenCalledWith({
      where: { workflowId: { in: ["x1", "x2"] } },
      select: { workflowId: true, workflowKey: true },
    });
    expect(out.totals).toEqual({ costUsd: 0.3, totalTokens: 150, calls: 2 });
    expect(out.byWorkflow.map((w) => w.workflowKey).sort()).toEqual([
      "summarize",
      "triage",
    ]);
    // Slice 2: the run-outcome rollups ride the same response.
    expect(out.runsByDay).toEqual([
      { date: "2026-07-16", total: 1, byStatus: { completed: 1 } },
    ]);
    expect(out.runsByWorkflow).toEqual([
      { workflowKey: "triage", runs: 1, avgDurationMs: 5000 },
    ]);
  });

  it("applies the date window and environmentId filter in the where clause (ledger AND run-rollup reads)", async () => {
    usageEvent.findMany.mockResolvedValue([]);
    execution.findMany.mockResolvedValue([]);

    const out = await svc.getInsights("t-1", {
      from: "2026-07-01",
      to: "2026-07-31",
      environmentId: "env-prod",
    });

    expect(usageEvent.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: "t-1",
        createdAt: { gte: new Date("2026-07-01"), lte: new Date("2026-07-31") },
        environmentId: "env-prod",
      },
      orderBy: { createdAt: "asc" },
    });
    // No events → no exec→key JOIN; the Slice-2 run rollup still reads the
    // Execution table with the SAME tenant/window/env scope.
    expect(execution.findMany).toHaveBeenCalledTimes(1);
    expect(execution.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: "t-1",
        createdAt: { gte: new Date("2026-07-01"), lte: new Date("2026-07-31") },
        environmentId: "env-prod",
      },
      select: {
        workflowKey: true,
        environmentId: true,
        status: true,
        createdAt: true,
        finishedAt: true,
        failureKind: true,
      },
    });
    expect(out.runsByDay).toEqual([]);
  });
});

describe("UsageController.insights", () => {
  it("delegates to the service with the parsed query params AND the principal (RBAC filter)", async () => {
    const service = { getInsights: vi.fn().mockResolvedValue({ ok: true }) };
    const ctrl = new UsageController(service as never);
    const principal = { tenantId: "t-1", userId: "u-1", role: "member" };

    await ctrl.insights(
      "t-1",
      "2026-07-01",
      "2026-07-31",
      "env-prod",
      principal as never,
    );

    expect(service.getInsights).toHaveBeenCalledWith(
      "t-1",
      {
        from: "2026-07-01",
        to: "2026-07-31",
        environmentId: "env-prod",
      },
      principal,
    );
  });

  it("threads the principal into getUsage too (SPA usage screen)", async () => {
    const service = { getUsage: vi.fn().mockResolvedValue({ ok: true }) };
    const ctrl = new UsageController(service as never);
    const principal = { tenantId: "t-1", userId: "u-1", role: "member" };

    await ctrl.get("t-1", undefined, undefined, principal as never);

    expect(service.getUsage).toHaveBeenCalledWith(
      "t-1",
      undefined,
      undefined,
      principal,
    );
  });
});
