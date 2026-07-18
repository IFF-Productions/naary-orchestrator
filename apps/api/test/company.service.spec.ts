import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyMembership = { findMany: vi.fn(), findUnique: vi.fn() };
const company = { create: vi.fn() };
const tenantSettings = {
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
const membership = { findUnique: vi.fn() };

vi.mock("@naary/db", () => ({
  getPrisma: () => ({ companyMembership, company, tenantSettings, membership }),
}));

import { CompanyService } from "../src/companies/company.service";

const svc = new CompanyService(
  {} as never, // ExecutionsService — not exercised in this spec
  {} as never, // GraphsService
  {} as never, // EnvironmentsService
);

// Membership roles keyed cheaply: companyMembership.findUnique returns { role } or null;
// membership.findUnique returns the user's workspace role or null.
beforeEach(() => {
  for (const m of [
    companyMembership.findMany,
    companyMembership.findUnique,
    company.create,
    tenantSettings.findUnique,
    tenantSettings.updateMany,
    tenantSettings.create,
    tenantSettings.update,
    membership.findUnique,
  ])
    m.mockReset();
});

describe("attachWorkspace — the owner-authorized invariant (§4)", () => {
  // THE load-bearing test: a company member who does NOT own the workspace must be rejected,
  // else a company admin could pull a victim's workspace in and gain cross-workspace read.
  it("REJECTS a company member who is not the workspace owner", async () => {
    companyMembership.findUnique.mockResolvedValue({ role: "admin" }); // is a company member
    membership.findUnique.mockResolvedValue({ role: "member" }); // but NOT the workspace owner
    await expect(
      svc.attachWorkspace("u1", "co1", "wsX", {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tenantSettings.updateMany).not.toHaveBeenCalled();
  });

  it("REJECTS a workspace owner who is not a company member", async () => {
    companyMembership.findUnique.mockResolvedValue(null); // not in the company
    membership.findUnique.mockResolvedValue({ role: "owner" });
    await expect(
      svc.attachWorkspace("u1", "co1", "wsX", {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tenantSettings.updateMany).not.toHaveBeenCalled();
  });

  it("ALLOWS a company member who owns the workspace → atomically claims companyId", async () => {
    companyMembership.findUnique.mockResolvedValue({ role: "owner" });
    membership.findUnique.mockResolvedValue({ role: "owner" });
    tenantSettings.updateMany.mockResolvedValue({ count: 1 }); // claim succeeds
    await svc.attachWorkspace("u1", "co1", "wsX", {});
    // Atomic conditional update: only when unattached OR already ours (race-safe).
    expect(tenantSettings.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: "wsX",
        OR: [{ companyId: null }, { companyId: "co1" }],
      },
      data: { companyId: "co1" },
    });
    expect(tenantSettings.create).not.toHaveBeenCalled();
  });

  it("creates the TenantSettings row when the workspace has none yet", async () => {
    companyMembership.findUnique.mockResolvedValue({ role: "owner" });
    membership.findUnique.mockResolvedValue({ role: "owner" });
    tenantSettings.updateMany.mockResolvedValue({ count: 0 }); // no row to claim
    tenantSettings.create.mockResolvedValue({});
    await svc.attachWorkspace("u1", "co1", "wsX", {});
    expect(tenantSettings.create).toHaveBeenCalledWith({
      data: { tenantId: "wsX", companyId: "co1" },
    });
  });

  it("accepts the AuthGuard active-workspace role as owner-proof (Membership backfill gap)", async () => {
    companyMembership.findUnique.mockResolvedValue({ role: "owner" });
    membership.findUnique.mockResolvedValue(null); // no Membership row yet
    tenantSettings.updateMany.mockResolvedValue({ count: 1 });
    await svc.attachWorkspace("u1", "co1", "wsX", {
      activeTenantId: "wsX",
      activeRole: "owner",
    });
    expect(tenantSettings.updateMany).toHaveBeenCalled();
  });

  it("REJECTS when the workspace is already attached to another company", async () => {
    companyMembership.findUnique.mockResolvedValue({ role: "owner" });
    membership.findUnique.mockResolvedValue({ role: "owner" });
    // The row exists (attached to otherCo): claim matches nothing, create hits the PK → P2002,
    // re-claim still matches nothing → 409.
    tenantSettings.updateMany.mockResolvedValue({ count: 0 });
    tenantSettings.create.mockRejectedValue({ code: "P2002" });
    await expect(
      svc.attachWorkspace("u1", "co1", "wsX", {}),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("detachWorkspace", () => {
  it("lets a company admin detach a workspace they don't own", async () => {
    tenantSettings.findUnique.mockResolvedValue({ companyId: "co1" });
    companyMembership.findUnique.mockResolvedValue({ role: "admin" });
    membership.findUnique.mockResolvedValue({ role: "member" }); // not the owner
    await svc.detachWorkspace("u1", "co1", "wsX", {});
    expect(tenantSettings.update).toHaveBeenCalledWith({
      where: { tenantId: "wsX" },
      data: { companyId: null },
    });
  });

  it("REJECTS a caller who is neither company admin nor workspace owner", async () => {
    tenantSettings.findUnique.mockResolvedValue({ companyId: "co1" });
    companyMembership.findUnique.mockResolvedValue(null);
    membership.findUnique.mockResolvedValue({ role: "member" });
    await expect(
      svc.detachWorkspace("u1", "co1", "wsX", {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("404s when the workspace isn't attached to this company", async () => {
    tenantSettings.findUnique.mockResolvedValue({ companyId: "otherCo" });
    await expect(
      svc.detachWorkspace("u1", "co1", "wsX", {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("create + list", () => {
  it("creates a company with the caller as owner + a derived slug", async () => {
    company.create.mockImplementation(
      async (args: { data: { slug: string } }) => ({
        id: "co1",
        name: "Acme Holdings",
        slug: args.data.slug,
      }),
    );
    const out = await svc.create("u1", "Acme Holdings");
    expect(out.role).toBe("owner");
    expect(out.slug).toMatch(/^acme-holdings-[0-9a-f]{6}$/);
    const arg = company.create.mock.calls[0][0];
    expect(arg.data.memberships.create).toEqual({
      userId: "u1",
      role: "owner",
    });
  });

  it("maps a duplicate slug to 409, not 500", async () => {
    company.create.mockRejectedValue({ code: "P2002" });
    await expect(svc.create("u1", "Acme")).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("rejects a blank name with 400 (client input error, not a 409 conflict)", async () => {
    await expect(svc.create("u1", "   ")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("lists the caller's companies with role", async () => {
    companyMembership.findMany.mockResolvedValue([
      { role: "owner", company: { id: "co1", name: "Acme", slug: "acme-x" } },
    ]);
    const out = await svc.listForUser("u1");
    expect(out).toEqual([
      { id: "co1", name: "Acme", slug: "acme-x", role: "owner" },
    ]);
  });
});
