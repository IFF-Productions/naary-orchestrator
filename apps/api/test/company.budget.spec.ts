import { ForbiddenException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyMembership = { findUnique: vi.fn() };
const companyBudget = { findUnique: vi.fn(), upsert: vi.fn() };
const tenantSettings = { findMany: vi.fn() };

// Fake Prisma.Decimal capturing the exact string handed to it, so the toFixed(2) write
// discipline is assertable without pulling the real Prisma runtime into the unit test.
// vi.hoisted so the class exists before the hoisted vi.mock factory references it.
const { FakeDecimal } = vi.hoisted(() => ({
  FakeDecimal: class FakeDecimal {
    constructor(public readonly value: string) {}
  },
}));

vi.mock("@naary/db", () => ({
  getPrisma: () => ({ companyMembership, companyBudget, tenantSettings }),
  Prisma: { Decimal: FakeDecimal },
}));

const spend = vi.hoisted(() => vi.fn());
vi.mock("@naary/usage", () => ({ monthToDateSpendForTenants: spend }));

import { CompaniesController } from "../src/companies/companies.controller";
import { CompanyService } from "../src/companies/company.service";

const svc = new CompanyService(
  {} as never, // ExecutionsService — not exercised here
  {} as never, // GraphsService
  {} as never, // EnvironmentsService
  {} as never, // PermissionsService — attach/detach fan-out, not exercised here
);

beforeEach(() => {
  for (const m of [
    companyMembership.findUnique,
    companyBudget.findUnique,
    companyBudget.upsert,
    tenantSettings.findMany,
    spend,
  ])
    m.mockReset();
});

describe("getCompanyBudget — authz + view", () => {
  it("REJECTS a non-member before any budget or spend read", async () => {
    companyMembership.findUnique.mockResolvedValue(null);
    await expect(svc.getCompanyBudget("u1", "co1")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(companyBudget.findUnique).not.toHaveBeenCalled();
    expect(tenantSettings.findMany).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
  });

  it("returns null budget + null remaining (but live spend) when no cap is configured", async () => {
    companyMembership.findUnique.mockResolvedValue({ role: "admin" });
    companyBudget.findUnique.mockResolvedValue(null);
    tenantSettings.findMany.mockResolvedValue([
      { tenantId: "ws1" },
      { tenantId: "ws2" },
    ]);
    spend.mockResolvedValue(3.5);

    const out = await svc.getCompanyBudget("u1", "co1");

    expect(out).toEqual({ budget: null, mtdSpendUsd: 3.5, remainingUsd: null });
    // The spend read is company-wide — the enumerated member tenantIds.
    expect(spend).toHaveBeenCalledWith(["ws1", "ws2"]);
  });

  it("returns the config + remaining for a member when a cap is set (admin can read)", async () => {
    companyMembership.findUnique.mockResolvedValue({ role: "admin" });
    companyBudget.findUnique.mockResolvedValue({
      companyId: "co1",
      monthlyCapUsd: "500.00", // Decimal stringifies; the service converts via Number()
      onBudgetExceeded: "reject",
    });
    tenantSettings.findMany.mockResolvedValue([{ tenantId: "ws1" }]);
    spend.mockResolvedValue(42.5);

    const out = await svc.getCompanyBudget("u1", "co1");

    expect(out).toEqual({
      budget: { monthlyCapUsd: 500, onBudgetExceeded: "reject" },
      mtdSpendUsd: 42.5,
      remainingUsd: 457.5,
    });
  });
});

describe("setCompanyBudget — owner-only write", () => {
  it("403s a company ADMIN (owner-only) before any write", async () => {
    companyMembership.findUnique.mockResolvedValue({ role: "admin" });
    await expect(
      svc.setCompanyBudget("u1", "co1", { monthlyCapUsd: 100 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(companyBudget.upsert).not.toHaveBeenCalled();
  });

  it("upserts for the OWNER with the toFixed(2) Decimal write discipline", async () => {
    companyMembership.findUnique.mockResolvedValue({ role: "owner" });
    companyBudget.upsert.mockResolvedValue({
      companyId: "co1",
      monthlyCapUsd: "100.00",
      onBudgetExceeded: "reject",
    });

    const out = await svc.setCompanyBudget("u1", "co1", {
      monthlyCapUsd: 100.005, // must be written as Decimal("100.00") / ("100.01") — toFixed(2)
    });

    const arg = companyBudget.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ companyId: "co1" });
    expect(arg.create.monthlyCapUsd).toBeInstanceOf(FakeDecimal);
    expect((arg.create.monthlyCapUsd as { value: string }).value).toBe(
      (100.005).toFixed(2),
    );
    expect(arg.update.monthlyCapUsd).toBeInstanceOf(FakeDecimal);
    // onBudgetExceeded omitted from the input → not written (the DB default/current value rules).
    expect(arg.create.onBudgetExceeded).toBeUndefined();
    expect(out).toEqual({ monthlyCapUsd: 100, onBudgetExceeded: "reject" });
  });
});

describe("CompaniesController /companies/:id/budget", () => {
  it("GET 403s an API-token principal (no userId) without calling the service", async () => {
    const getCompanyBudget = vi.fn();
    const controller = new CompaniesController({
      getCompanyBudget,
    } as unknown as CompanyService);
    await expect(
      controller.getBudget({ tenantId: "t1" } as never, "co1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(getCompanyBudget).not.toHaveBeenCalled();
  });

  it("PUT 403s an API-token principal (no userId) without calling the service", async () => {
    const setCompanyBudget = vi.fn();
    const controller = new CompaniesController({
      setCompanyBudget,
    } as unknown as CompanyService);
    await expect(
      controller.setBudget({ tenantId: "t1" } as never, "co1", {
        monthlyCapUsd: 100,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(setCompanyBudget).not.toHaveBeenCalled();
  });

  it("passes the signed-in user's id + body through to the service", async () => {
    const setCompanyBudget = vi.fn().mockResolvedValue({ ok: true });
    const controller = new CompaniesController({
      setCompanyBudget,
    } as unknown as CompanyService);
    await controller.setBudget({ userId: "u1" } as never, "co1", {
      monthlyCapUsd: 250,
      onBudgetExceeded: "reject",
    });
    expect(setCompanyBudget).toHaveBeenCalledWith("u1", "co1", {
      monthlyCapUsd: 250,
      onBudgetExceeded: "reject",
    });
  });
});
