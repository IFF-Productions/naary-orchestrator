import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyPermissionGroup = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
const companyGroupMember = { upsert: vi.fn(), deleteMany: vi.fn() };
const companyWorkflowGrant = {
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
const companyMembership = { findUnique: vi.fn() };

vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    companyPermissionGroup,
    companyGroupMember,
    companyWorkflowGrant,
    companyMembership,
  }),
}));

import { CompanyGroupsController } from "../src/companies/company-groups.controller";
import { CompanyGroupsService } from "../src/companies/company-groups.service";

// CompanyService is stubbed at the seam the service actually uses: the owner gate.
const assertCompanyOwner = vi.fn();
const permissions = { invalidateCompany: vi.fn().mockResolvedValue(undefined) };
const svc = new CompanyGroupsService(
  { assertCompanyOwner } as never,
  permissions as never,
);

const GROUP_ROW = {
  id: "cpg-1",
  companyId: "co-1",
  name: "Platform admins",
  createdAt: new Date("2026-08-03T00:00:00Z"),
  members: [],
  grants: [],
};

beforeEach(() => {
  for (const group of [
    companyPermissionGroup,
    companyGroupMember,
    companyWorkflowGrant,
    companyMembership,
  ]) {
    for (const fn of Object.values(group)) fn.mockReset();
  }
  assertCompanyOwner.mockReset().mockResolvedValue(undefined);
  permissions.invalidateCompany.mockClear();
  companyPermissionGroup.findFirst.mockResolvedValue({ id: "cpg-1" });
  companyPermissionGroup.create.mockResolvedValue(GROUP_ROW);
  companyPermissionGroup.update.mockResolvedValue(GROUP_ROW);
  companyPermissionGroup.delete.mockResolvedValue({});
  companyGroupMember.upsert.mockResolvedValue({});
  companyGroupMember.deleteMany.mockResolvedValue({ count: 1 });
  companyMembership.findUnique.mockResolvedValue({ userId: "u-target" });
});

// ---------------------------------------------------------------------------
// Owner gating: EVERY method goes through assertCompanyOwner FIRST — a company
// admin (non-owner) gets 403 before any read or write.
// ---------------------------------------------------------------------------
describe("company-OWNER gating", () => {
  it("an admin (assertCompanyOwner throws) is 403'd on every method, before any write", async () => {
    assertCompanyOwner.mockRejectedValue(
      new ForbiddenException("Only the company owner can do that."),
    );
    await expect(svc.list("u-adm", "co-1")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(svc.create("u-adm", "co-1", "G")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      svc.rename("u-adm", "co-1", "cpg-1", "G2"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.remove("u-adm", "co-1", "cpg-1")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      svc.addMember("u-adm", "co-1", "cpg-1", "u-t"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      svc.removeMember("u-adm", "co-1", "cpg-1", "u-t"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      svc.setGrant("u-adm", "co-1", "cpg-1", { canView: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(companyPermissionGroup.create).not.toHaveBeenCalled();
    expect(companyGroupMember.upsert).not.toHaveBeenCalled();
    expect(companyWorkflowGrant.create).not.toHaveBeenCalled();
    expect(permissions.invalidateCompany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cross-company isolation: a group id of ANOTHER company is a 404, never touched.
// ---------------------------------------------------------------------------
describe("cross-company isolation", () => {
  it("404s a group that isn't THIS company's (lookup pins companyId)", async () => {
    companyPermissionGroup.findFirst.mockResolvedValue(null); // not in co-1
    await expect(
      svc.addMember("u-own", "co-1", "cpg-of-co2", "u-t"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(companyPermissionGroup.findFirst).toHaveBeenCalledWith({
      where: { id: "cpg-of-co2", companyId: "co-1" },
      select: { id: true },
    });
    expect(companyGroupMember.upsert).not.toHaveBeenCalled();
  });
});

describe("group CRUD", () => {
  it("create trims the name, 409s a duplicate, and fans out invalidation", async () => {
    await svc.create("u-own", "co-1", "  Platform admins  ");
    expect(companyPermissionGroup.create.mock.calls[0][0].data).toEqual({
      companyId: "co-1",
      name: "Platform admins",
    });
    expect(permissions.invalidateCompany).toHaveBeenCalledWith("co-1");
    companyPermissionGroup.create.mockRejectedValue({ code: "P2002" });
    await expect(svc.create("u-own", "co-1", "Dup")).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("create 400s a blank name", async () => {
    await expect(svc.create("u-own", "co-1", "   ")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("delete cascades the group and fans out invalidation to every attached tenant", async () => {
    await svc.remove("u-own", "co-1", "cpg-1");
    expect(companyPermissionGroup.delete).toHaveBeenCalledWith({
      where: { id: "cpg-1" },
    });
    expect(permissions.invalidateCompany).toHaveBeenCalledWith("co-1");
  });
});

describe("members (uid-keyed, company members only)", () => {
  it("400s a target with NO CompanyMembership in this company", async () => {
    companyMembership.findUnique.mockResolvedValue(null);
    await expect(
      svc.addMember("u-own", "co-1", "cpg-1", "u-outsider"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(companyMembership.findUnique).toHaveBeenCalledWith({
      where: { companyId_userId: { companyId: "co-1", userId: "u-outsider" } },
      select: { userId: true },
    });
    expect(companyGroupMember.upsert).not.toHaveBeenCalled();
    expect(permissions.invalidateCompany).not.toHaveBeenCalled();
  });

  it("adds a company member idempotently (upsert) + fans out", async () => {
    await svc.addMember("u-own", "co-1", "cpg-1", "u-target");
    expect(companyGroupMember.upsert).toHaveBeenCalledWith({
      where: { groupId_userId: { groupId: "cpg-1", userId: "u-target" } },
      create: { groupId: "cpg-1", userId: "u-target" },
      update: {},
    });
    expect(permissions.invalidateCompany).toHaveBeenCalledWith("co-1");
  });

  it("removeMember deletes the join row + fans out", async () => {
    await svc.removeMember("u-own", "co-1", "cpg-1", "u-target");
    expect(companyGroupMember.deleteMany).toHaveBeenCalledWith({
      where: { groupId: "cpg-1", userId: "u-target" },
    });
    expect(permissions.invalidateCompany).toHaveBeenCalledWith("co-1");
  });
});

describe("the single grant row (PUT upsert, six verbs, replace semantics)", () => {
  const grantRow = {
    id: "cg-1",
    canView: true,
    canRun: true,
    canEdit: false,
    canDelete: false,
    canShare: false,
    canCreate: false,
    createdAt: new Date("2026-08-03T00:00:00Z"),
  };

  it("creates the row when none exists — absent verbs become false", async () => {
    companyWorkflowGrant.findFirst.mockResolvedValue(null);
    companyWorkflowGrant.create.mockResolvedValue(grantRow);
    const out = await svc.setGrant("u-own", "co-1", "cpg-1", {
      canView: true,
      canRun: true,
    });
    expect(companyWorkflowGrant.create).toHaveBeenCalledWith({
      data: {
        groupId: "cpg-1",
        canView: true,
        canRun: true,
        canEdit: false,
        canDelete: false,
        canShare: false,
        canCreate: false,
      },
    });
    expect(out.canRun).toBe(true);
    expect(permissions.invalidateCompany).toHaveBeenCalledWith("co-1");
  });

  it("updates (not duplicates) the existing row — one grant per group", async () => {
    companyWorkflowGrant.findFirst.mockResolvedValue({ id: "cg-1" });
    companyWorkflowGrant.update.mockResolvedValue({
      ...grantRow,
      canRun: false,
    });
    await svc.setGrant("u-own", "co-1", "cpg-1", { canView: true });
    expect(companyWorkflowGrant.create).not.toHaveBeenCalled();
    expect(companyWorkflowGrant.update).toHaveBeenCalledWith({
      where: { id: "cg-1" },
      data: {
        canView: true,
        canRun: false,
        canEdit: false,
        canDelete: false,
        canShare: false,
        canCreate: false,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Controller: API-token principals (no uid) are forbidden outright — company
// groups are uid-keyed and tokens are workspace-scoped subjects.
// ---------------------------------------------------------------------------
describe("CompanyGroupsController token rejection", () => {
  const controller = new CompanyGroupsController(svc);
  const tokenPrincipal = { tenantId: "t-1", role: "owner" } as never;

  it("403s an nry_ token principal on every route, before any service work", async () => {
    // requireUser throws BEFORE the service is even entered — synchronously on the
    // non-async routes, as a rejection on the async ones.
    expect(() => controller.list(tokenPrincipal, "co-1")).toThrow(
      ForbiddenException,
    );
    expect(() =>
      controller.create(tokenPrincipal, "co-1", { name: "G" }),
    ).toThrow(ForbiddenException);
    expect(() =>
      controller.setGrant(tokenPrincipal, "co-1", "cpg-1", { canView: true }),
    ).toThrow(ForbiddenException);
    await expect(
      controller.addMember(tokenPrincipal, "co-1", "cpg-1", "u-t"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.remove(tokenPrincipal, "co-1", "cpg-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(assertCompanyOwner).not.toHaveBeenCalled();
  });
});
