import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyMembership = {
  findUnique: vi.fn(),
  findMany: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
  count: vi.fn(),
};
const tenantSettings = {
  findUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
};
const membership = { findFirst: vi.fn(), findMany: vi.fn() };

vi.mock("@naary/db", () => ({
  getPrisma: () => ({ companyMembership, tenantSettings, membership }),
}));

import { CompaniesController } from "../src/companies/companies.controller";
import { CompanyService } from "../src/companies/company.service";

// The manage surface never touches these collaborators.
const svc = new CompanyService(
  {} as never,
  {} as never,
  {} as never,
  {} as never,
);

beforeEach(() => {
  for (const group of [companyMembership, tenantSettings, membership]) {
    for (const fn of Object.values(group)) fn.mockReset();
  }
  // Defaults: caller is a company OWNER, workspace attached to c-1, writes succeed.
  companyMembership.findUnique.mockResolvedValue({ role: "owner" });
  companyMembership.count.mockResolvedValue(2);
  companyMembership.upsert.mockResolvedValue({});
  companyMembership.delete.mockResolvedValue({});
  tenantSettings.findUnique.mockResolvedValue({ companyId: "c-1" });
  tenantSettings.update.mockResolvedValue({});
  // The company owns two workspaces — the only place addMember may resolve an email from.
  tenantSettings.findMany.mockResolvedValue([
    { tenantId: "t-1" },
    { tenantId: "t-2" },
  ]);
});

// §4 ordering is the privacy invariant: company membership FIRST, then the attached-to-THIS-
// company check, before any write into the target workspace.
describe("renameWorkspace (slice 4)", () => {
  it("403s a NON-member BEFORE any tenantSettings read or write", async () => {
    companyMembership.findUnique.mockResolvedValue(null);
    await expect(
      svc.renameWorkspace("u-1", "c-1", "t-victim", "Pwned"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tenantSettings.findUnique).not.toHaveBeenCalled();
    expect(tenantSettings.update).not.toHaveBeenCalled();
  });

  it("404s when the workspace is not attached to THIS company (no write)", async () => {
    tenantSettings.findUnique.mockResolvedValue({ companyId: "c-OTHER" });
    await expect(
      svc.renameWorkspace("u-1", "c-1", "t-2", "New"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tenantSettings.update).not.toHaveBeenCalled();
  });

  it("trims the name and writes displayName", async () => {
    await svc.renameWorkspace("u-1", "c-1", "t-2", "  Acme Prod  ");
    expect(tenantSettings.update).toHaveBeenCalledWith({
      where: { tenantId: "t-2" },
      data: { displayName: "Acme Prod" },
    });
  });

  it("400s an empty (or whitespace-only) name without writing", async () => {
    await expect(
      svc.renameWorkspace("u-1", "c-1", "t-2", "   "),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tenantSettings.update).not.toHaveBeenCalled();
  });

  it("400s a name over 80 characters", async () => {
    await expect(
      svc.renameWorkspace("u-1", "c-1", "t-2", "x".repeat(81)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tenantSettings.update).not.toHaveBeenCalled();
  });
});

describe("setWorkspaceArchived (slice 4)", () => {
  it("403s a NON-member before any read/write", async () => {
    companyMembership.findUnique.mockResolvedValue(null);
    await expect(
      svc.setWorkspaceArchived("u-1", "c-1", "t-2", true),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tenantSettings.findUnique).not.toHaveBeenCalled();
    expect(tenantSettings.update).not.toHaveBeenCalled();
  });

  it("404s an unattached workspace", async () => {
    tenantSettings.findUnique.mockResolvedValue(null);
    await expect(
      svc.setWorkspaceArchived("u-1", "c-1", "t-2", true),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tenantSettings.update).not.toHaveBeenCalled();
  });

  it("archive sets archivedAt to a Date; unarchive nulls it; both idempotent", async () => {
    await svc.setWorkspaceArchived("u-1", "c-1", "t-2", true);
    let call = tenantSettings.update.mock.calls[0][0];
    expect(call.where).toEqual({ tenantId: "t-2" });
    expect(call.data.archivedAt).toBeInstanceOf(Date);

    // Idempotent: archiving again is just another timestamp write, no error.
    await svc.setWorkspaceArchived("u-1", "c-1", "t-2", true);
    expect(tenantSettings.update).toHaveBeenCalledTimes(2);

    await svc.setWorkspaceArchived("u-1", "c-1", "t-2", false);
    call = tenantSettings.update.mock.calls[2][0];
    expect(call.data).toEqual({ archivedAt: null });

    await svc.setWorkspaceArchived("u-1", "c-1", "t-2", false);
    expect(tenantSettings.update).toHaveBeenCalledTimes(4);
  });
});

describe("listMembers (slice 4)", () => {
  it("403s a non-member without reading the roster", async () => {
    companyMembership.findUnique.mockResolvedValue(null);
    await expect(svc.listMembers("u-1", "c-1")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(companyMembership.findMany).not.toHaveBeenCalled();
  });

  it("enriches emails from Membership — first non-null per uid; null when unknown", async () => {
    companyMembership.findMany.mockResolvedValue([
      { userId: "u-1", role: "owner" },
      { userId: "u-2", role: "admin" },
    ]);
    // u-1 has a null-email row before a real one (emails are nullable); u-2 has none at all.
    membership.findMany.mockResolvedValue([
      { userId: "u-1", email: null },
      { userId: "u-1", email: "owner@acme.com" },
    ]);
    const out = await svc.listMembers("u-1", "c-1");
    expect(out).toEqual([
      { userId: "u-1", email: "owner@acme.com", role: "owner" },
      { userId: "u-2", email: null, role: "admin" },
    ]);
    expect(membership.findMany).toHaveBeenCalledWith({
      where: { userId: { in: ["u-1", "u-2"] } },
      select: { userId: true, email: true },
    });
  });
});

describe("addMember (slice 4) — owner-only, email→uid via Membership", () => {
  it("403s a company ADMIN (owner-only) before any lookup", async () => {
    companyMembership.findUnique.mockResolvedValue({ role: "admin" });
    await expect(
      svc.addMember("u-1", "c-1", "a@b.co", "admin"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(membership.findFirst).not.toHaveBeenCalled();
    expect(companyMembership.upsert).not.toHaveBeenCalled();
  });

  it("400s a role outside owner|admin", async () => {
    await expect(
      svc.addMember("u-1", "c-1", "a@b.co", "member"),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(membership.findFirst).not.toHaveBeenCalled();
  });

  it("resolves the uid case-insensitively from MEMBERSHIP (not the inert Member table)", async () => {
    membership.findFirst.mockResolvedValue({ userId: "u-9" });
    // Target isn't an existing member → the demote guard's lookup returns null.
    companyMembership.findUnique
      .mockResolvedValueOnce({ role: "owner" }) // caller
      .mockResolvedValueOnce(null); // target's existing company role
    const out = await svc.addMember("u-1", "c-1", "  User@Acme.com  ", "admin");
    expect(membership.findFirst).toHaveBeenCalledWith({
      where: {
        email: { equals: "User@Acme.com", mode: "insensitive" },
        // #1075 decision 3 — the candidate set is this COMPANY's workspaces, never the instance.
        tenantId: { in: ["t-1", "t-2"] },
      },
      orderBy: { createdAt: "desc" },
      select: { userId: true },
    });
    expect(companyMembership.upsert).toHaveBeenCalledWith({
      where: { companyId_userId: { companyId: "c-1", userId: "u-9" } },
      create: { companyId: "c-1", userId: "u-9", role: "admin" },
      update: { role: "admin" },
    });
    expect(out).toEqual({
      userId: "u-9",
      email: "User@Acme.com",
      role: "admin",
    });
  });

  /**
   * #1075 decision 3 (LDAP-DIRECTORY.md §5, SAML-SSO.md:136) — the prerequisite SCIM makes due.
   *
   * The lookup used to run across the WHOLE INSTANCE with "newest row wins", so whichever
   * workspace most recently created a Membership for an address won it — including a workspace
   * with no relationship to this company. Human invites made that rare; a SCIM connection
   * creating memberships in bulk, automatically, makes it routine. Here the outsider's row is
   * the NEWEST, so an unscoped lookup returns them and the company owner grants company-wide
   * admin to a stranger who merely shares an email address with their colleague.
   */
  it("resolves the email inside THIS COMPANY's workspaces, not the newest row on the instance", async () => {
    const rows = [
      // Newest first in wall-clock terms — and outside the company.
      {
        userId: "u-outsider",
        email: "same@acme.com",
        tenantId: "t-elsewhere",
        createdAt: new Date("2026-08-05"),
      },
      {
        userId: "u-colleague",
        email: "same@acme.com",
        tenantId: "t-1",
        createdAt: new Date("2026-01-01"),
      },
    ];
    membership.findFirst.mockImplementation(
      async ({
        where,
      }: {
        where: {
          email: { equals: string };
          tenantId?: { in: string[] };
        };
      }) => {
        const allowed = where.tenantId?.in;
        const hits = rows
          .filter(
            (r) =>
              r.email.toLowerCase() === where.email.equals.toLowerCase() &&
              (!allowed || allowed.includes(r.tenantId)),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return hits[0] ?? null;
      },
    );
    companyMembership.findUnique
      .mockResolvedValueOnce({ role: "owner" }) // caller
      .mockResolvedValueOnce(null); // target has no company role yet

    await svc.addMember("u-1", "c-1", "same@acme.com", "admin");
    expect(companyMembership.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { companyId: "c-1", userId: "u-colleague", role: "admin" },
      }),
    );
  });

  it("404s an email that exists ONLY outside the company's workspaces", async () => {
    tenantSettings.findMany.mockResolvedValue([{ tenantId: "t-1" }]);
    membership.findFirst.mockImplementation(
      async ({ where }: { where: { tenantId?: { in: string[] } } }) =>
        where.tenantId?.in?.includes("t-elsewhere")
          ? { userId: "u-outsider" }
          : null,
    );
    await expect(
      svc.addMember("u-1", "c-1", "stranger@acme.com", "admin"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(companyMembership.upsert).not.toHaveBeenCalled();
  });

  it("404s without querying memberships at all when the company owns no workspaces", async () => {
    tenantSettings.findMany.mockResolvedValue([]);
    await expect(
      svc.addMember("u-1", "c-1", "anyone@acme.com", "admin"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(membership.findFirst).not.toHaveBeenCalled();
  });

  it("404s an unknown email with the sign-in-first message", async () => {
    membership.findFirst.mockResolvedValue(null);
    await expect(
      svc.addMember("u-1", "c-1", "ghost@acme.com", "admin"),
    ).rejects.toThrow(/must sign in to one of them first/);
    expect(companyMembership.upsert).not.toHaveBeenCalled();
  });

  it("409s re-adding the FINAL owner as admin (last-owner demote guard)", async () => {
    membership.findFirst.mockResolvedValue({ userId: "u-1" });
    companyMembership.findUnique
      .mockResolvedValueOnce({ role: "owner" }) // caller
      .mockResolvedValueOnce({ role: "owner" }); // target is currently an owner
    companyMembership.count.mockResolvedValue(1); // …and the only one
    await expect(
      svc.addMember("u-1", "c-1", "owner@acme.com", "admin"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(companyMembership.upsert).not.toHaveBeenCalled();
  });

  it("allows demoting an owner when ANOTHER owner remains", async () => {
    membership.findFirst.mockResolvedValue({ userId: "u-2" });
    companyMembership.findUnique
      .mockResolvedValueOnce({ role: "owner" }) // caller
      .mockResolvedValueOnce({ role: "owner" }); // target
    companyMembership.count.mockResolvedValue(2);
    await svc.addMember("u-1", "c-1", "co@acme.com", "admin");
    expect(companyMembership.upsert).toHaveBeenCalled();
  });
});

describe("removeMember (slice 4) — owner or self-leave", () => {
  it("403s a NON-member caller", async () => {
    companyMembership.findUnique.mockResolvedValue(null);
    await expect(
      svc.removeMember("u-outsider", "c-1", "u-2"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(companyMembership.delete).not.toHaveBeenCalled();
  });

  it("403s an ADMIN removing someone else (owner-only) — but allows self-leave", async () => {
    companyMembership.findUnique
      .mockResolvedValueOnce({ role: "admin" }) // caller
      .mockResolvedValueOnce({ role: "admin" }); // (not reached for the other-removal)
    await expect(
      svc.removeMember("u-admin", "c-1", "u-2"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(companyMembership.delete).not.toHaveBeenCalled();

    // Self-leave: same admin, own uid — allowed.
    companyMembership.findUnique
      .mockResolvedValueOnce({ role: "admin" }) // caller
      .mockResolvedValueOnce({ role: "admin" }); // target = self
    await svc.removeMember("u-admin", "c-1", "u-admin");
    expect(companyMembership.delete).toHaveBeenCalledWith({
      where: { companyId_userId: { companyId: "c-1", userId: "u-admin" } },
    });
  });

  it("404s when the target is not a member", async () => {
    companyMembership.findUnique
      .mockResolvedValueOnce({ role: "owner" }) // caller
      .mockResolvedValueOnce(null); // target
    await expect(
      svc.removeMember("u-1", "c-1", "u-ghost"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(companyMembership.delete).not.toHaveBeenCalled();
  });

  it("409s removing the FINAL owner — even by themselves", async () => {
    companyMembership.findUnique
      .mockResolvedValueOnce({ role: "owner" }) // caller
      .mockResolvedValueOnce({ role: "owner" }); // target (self)
    companyMembership.count.mockResolvedValue(1);
    await expect(svc.removeMember("u-1", "c-1", "u-1")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(companyMembership.delete).not.toHaveBeenCalled();
  });

  it("owner removes another owner when one remains", async () => {
    companyMembership.findUnique
      .mockResolvedValueOnce({ role: "owner" }) // caller
      .mockResolvedValueOnce({ role: "owner" }); // target
    companyMembership.count.mockResolvedValue(2);
    await svc.removeMember("u-1", "c-1", "u-2");
    expect(companyMembership.delete).toHaveBeenCalled();
  });
});

describe("CompaniesController slice-4 routes", () => {
  function controller() {
    const svc = {
      renameWorkspace: vi.fn().mockResolvedValue(undefined),
      setWorkspaceArchived: vi.fn().mockResolvedValue(undefined),
      listMembers: vi.fn().mockResolvedValue([]),
      addMember: vi.fn().mockResolvedValue({}),
      removeMember: vi.fn().mockResolvedValue(undefined),
    };
    return {
      c: new CompaniesController(svc as unknown as CompanyService),
      svc,
    };
  }

  it("403s API-token principals (no uid) on every management route, before the service", async () => {
    const { c, svc } = controller();
    const token = { tenantId: "t-1" } as never;
    await expect(
      c.renameWorkspace(token, "c-1", "t-2", { displayName: "X" }),
    ).rejects.toThrow(/signed-in user/);
    await expect(c.archiveWorkspace(token, "c-1", "t-2")).rejects.toThrow(
      /signed-in user/,
    );
    await expect(c.unarchiveWorkspace(token, "c-1", "t-2")).rejects.toThrow(
      /signed-in user/,
    );
    await expect(c.listMembers(token, "c-1")).rejects.toThrow(/signed-in user/);
    await expect(
      c.addMember(token, "c-1", { email: "a@b.co" }),
    ).rejects.toThrow(/signed-in user/);
    await expect(c.removeMember(token, "c-1", "u-2")).rejects.toThrow(
      /signed-in user/,
    );
    for (const fn of Object.values(svc)) expect(fn).not.toHaveBeenCalled();
  });

  it("archive/unarchive route to setWorkspaceArchived(true|false)", async () => {
    const { c, svc } = controller();
    const user = { userId: "u-1" } as never;
    await c.archiveWorkspace(user, "c-1", "t-2");
    expect(svc.setWorkspaceArchived).toHaveBeenCalledWith(
      "u-1",
      "c-1",
      "t-2",
      true,
    );
    await c.unarchiveWorkspace(user, "c-1", "t-2");
    expect(svc.setWorkspaceArchived).toHaveBeenCalledWith(
      "u-1",
      "c-1",
      "t-2",
      false,
    );
  });

  it("addMember defaults the role to admin and passes the email through", async () => {
    const { c, svc } = controller();
    await c.addMember({ userId: "u-1" } as never, "c-1", {
      email: "a@b.co",
    });
    expect(svc.addMember).toHaveBeenCalledWith("u-1", "c-1", "a@b.co", "admin");
  });
});
