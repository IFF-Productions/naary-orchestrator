import { ForbiddenException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyMembership = { findMany: vi.fn(), findUnique: vi.fn() };
const tenantSettings = { findMany: vi.fn() };
const usageEvent = { findMany: vi.fn() };

vi.mock("@naary/db", () => ({
  getPrisma: () => ({ companyMembership, tenantSettings, usageEvent }),
}));

import { CompaniesController } from "../src/companies/companies.controller";
import { CompanyService } from "../src/companies/company.service";

const svc = new CompanyService(
  {} as never, // ExecutionsService — not exercised in this spec
  {} as never, // GraphsService
  {} as never, // EnvironmentsService
);

// Ledger rows carry Decimal costUsd — fake it as the string Prisma's Decimal stringifies to
// (Decimal(12,6)); the service converts via Number(r.costUsd), same as usage.service.ts.
function event(over: Partial<Record<string, unknown>> = {}) {
  return {
    tenantId: "ws1",
    environmentId: "env-prod",
    totalTokens: 100,
    costUsd: "0.100000",
    ...over,
  };
}

beforeEach(() => {
  for (const m of [
    companyMembership.findMany,
    companyMembership.findUnique,
    tenantSettings.findMany,
    usageEvent.findMany,
  ])
    m.mockReset();
});

describe("getCompanyUsage — §4 authz gate", () => {
  // THE load-bearing test: company membership is the ONLY thing authorizing the cross-workspace
  // read — a non-member must be rejected BEFORE any workspace enumeration or ledger read.
  it("REJECTS a non-member before touching tenantSettings or the usage ledger", async () => {
    companyMembership.findUnique.mockResolvedValue(null);
    await expect(svc.getCompanyUsage("u1", "co1")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(tenantSettings.findMany).not.toHaveBeenCalled();
    expect(usageEvent.findMany).not.toHaveBeenCalled();
  });
});

describe("getCompanyUsage — rollup math", () => {
  beforeEach(() => {
    companyMembership.findUnique.mockResolvedValue({ role: "admin" });
  });

  it("returns an empty rollup (not an error) for a company with no workspaces", async () => {
    tenantSettings.findMany.mockResolvedValue([]);
    const out = await svc.getCompanyUsage("u1", "co1");
    expect(out).toEqual({
      range: { from: null, to: null },
      totals: { costUsd: 0, totalTokens: 0, calls: 0 },
      byWorkspace: [],
    });
    expect(usageEvent.findMany).not.toHaveBeenCalled();
  });

  it("rolls up totals + per-workspace + nested per-environment, desc by cost", async () => {
    tenantSettings.findMany.mockResolvedValue([
      { tenantId: "ws1", displayName: "Acme Prod", archivedAt: null },
      {
        tenantId: "ws2",
        displayName: null,
        archivedAt: new Date("2026-07-01"),
      },
    ]);
    usageEvent.findMany.mockResolvedValue([
      event({
        tenantId: "ws1",
        environmentId: "env-prod",
        costUsd: "0.100000",
        totalTokens: 100,
      }),
      event({
        tenantId: "ws1",
        environmentId: "env-sandbox",
        costUsd: "0.300000",
        totalTokens: 300,
      }),
      // Pre-tagging row → the null environment bucket.
      event({
        tenantId: "ws1",
        environmentId: null,
        costUsd: "0.012345",
        totalTokens: 10,
      }),
      event({
        tenantId: "ws2",
        environmentId: "env-prod",
        costUsd: "0.500000",
        totalTokens: 500,
      }),
    ]);

    const out = await svc.getCompanyUsage("u1", "co1");

    expect(out.totals).toEqual({
      costUsd: 0.912345,
      totalTokens: 910,
      calls: 4,
    });
    // ws2 spent more → listed first; displayName null when missing.
    expect(out.byWorkspace.map((w) => w.tenantId)).toEqual(["ws2", "ws1"]);
    expect(out.byWorkspace[0]).toEqual({
      tenantId: "ws2",
      displayName: null,
      archived: true, // Slice 4: archivedAt set → flagged, row NOT dropped from the rollup
      costUsd: 0.5,
      totalTokens: 500,
      calls: 1,
      byEnvironment: [
        { environmentId: "env-prod", costUsd: 0.5, totalTokens: 500, calls: 1 },
      ],
    });
    const ws1 = out.byWorkspace[1];
    expect(ws1.displayName).toBe("Acme Prod");
    expect(ws1.archived).toBe(false);
    expect(ws1.costUsd).toBeCloseTo(0.412345, 9);
    expect(ws1.totalTokens).toBe(410);
    expect(ws1.calls).toBe(3);
    // Nested env buckets desc by cost; null buckets the pre-tagging row.
    expect(ws1.byEnvironment).toEqual([
      {
        environmentId: "env-sandbox",
        costUsd: 0.3,
        totalTokens: 300,
        calls: 1,
      },
      { environmentId: "env-prod", costUsd: 0.1, totalTokens: 100, calls: 1 },
      { environmentId: null, costUsd: 0.012345, totalTokens: 10, calls: 1 },
    ]);
  });

  it("queries ONLY this company's workspaces — the IN list equals the enumerated tenantIds", async () => {
    tenantSettings.findMany.mockResolvedValue([
      { tenantId: "ws1", displayName: null },
      { tenantId: "ws2", displayName: null },
    ]);
    usageEvent.findMany.mockResolvedValue([]);
    await svc.getCompanyUsage("u1", "co1");
    expect(tenantSettings.findMany).toHaveBeenCalledWith({
      where: { companyId: "co1" },
      select: { tenantId: true, displayName: true, archivedAt: true },
    });
    expect(usageEvent.findMany).toHaveBeenCalledWith({
      where: { tenantId: { in: ["ws1", "ws2"] } },
    });
  });

  it("forwards the from/to window into the createdAt where clause", async () => {
    tenantSettings.findMany.mockResolvedValue([
      { tenantId: "ws1", displayName: null },
    ]);
    usageEvent.findMany.mockResolvedValue([]);
    const out = await svc.getCompanyUsage("u1", "co1", {
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(usageEvent.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: { in: ["ws1"] },
        createdAt: {
          gte: new Date("2026-07-01"),
          lte: new Date("2026-07-31"),
        },
      },
    });
    // The window is echoed back verbatim.
    expect(out.range).toEqual({ from: "2026-07-01", to: "2026-07-31" });
  });

  it("still lists a zero-spend workspace (zero totals, empty byEnvironment)", async () => {
    tenantSettings.findMany.mockResolvedValue([
      { tenantId: "ws1", displayName: "Busy" },
      { tenantId: "ws-idle", displayName: "Idle" },
    ]);
    usageEvent.findMany.mockResolvedValue([event({ tenantId: "ws1" })]);
    const out = await svc.getCompanyUsage("u1", "co1");
    expect(out.byWorkspace).toHaveLength(2);
    expect(out.byWorkspace[1]).toEqual({
      tenantId: "ws-idle",
      displayName: "Idle",
      archived: false,
      costUsd: 0,
      totalTokens: 0,
      calls: 0,
      byEnvironment: [],
    });
  });
});

describe("CompaniesController GET /companies/:id/usage", () => {
  it("403s an API-token principal (no userId) without calling the service", async () => {
    const getCompanyUsage = vi.fn();
    const controller = new CompaniesController({
      getCompanyUsage,
    } as unknown as CompanyService);
    await expect(
      controller.usage({ tenantId: "t1" } as never, "co1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(getCompanyUsage).not.toHaveBeenCalled();
  });

  it("passes the signed-in user's id + window through to the service", async () => {
    const getCompanyUsage = vi.fn().mockResolvedValue({ ok: true });
    const controller = new CompaniesController({
      getCompanyUsage,
    } as unknown as CompanyService);
    await controller.usage(
      { userId: "u1", tenantId: "t1" } as never,
      "co1",
      "2026-07-01",
      "2026-07-31",
    );
    expect(getCompanyUsage).toHaveBeenCalledWith("u1", "co1", {
      from: "2026-07-01",
      to: "2026-07-31",
    });
  });
});
