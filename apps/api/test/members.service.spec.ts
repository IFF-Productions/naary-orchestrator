import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const upsert = vi.fn();
const deleteMany = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({ member: { findMany, upsert, deleteMany } }),
}));

import { MembersService } from "../src/members/members.service";

const svc = new MembersService();
const now = new Date("2026-01-01T00:00:00.000Z");

beforeEach(() => {
  findMany.mockReset();
  upsert.mockReset();
  deleteMany.mockReset();
});

describe("MembersService", () => {
  it("lists the tenant's members as views", async () => {
    findMany.mockResolvedValue([
      { id: "m1", email: "a@x.com", role: "owner", createdAt: now },
    ]);
    expect(await svc.list("t-1")).toEqual([
      {
        id: "m1",
        email: "a@x.com",
        role: "owner",
        createdAt: now.toISOString(),
      },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId: "t-1" },
      orderBy: { createdAt: "asc" },
    });
  });

  it("upserts by (tenantId, email) on add", async () => {
    upsert.mockResolvedValue({
      id: "m2",
      email: "b@x.com",
      role: "admin",
      createdAt: now,
    });
    const v = await svc.add("t-1", "b@x.com", "admin");
    expect(v.role).toBe("admin");
    expect(upsert.mock.calls[0][0].where).toEqual({
      tenantId_email: { tenantId: "t-1", email: "b@x.com" },
    });
  });

  it("scopes removal to the tenant (deleteMany, never cross-tenant)", async () => {
    deleteMany.mockResolvedValue({ count: 1 });
    await svc.remove("t-1", "m9");
    expect(deleteMany).toHaveBeenCalledWith({
      where: { tenantId: "t-1", id: "m9" },
    });
  });
});
