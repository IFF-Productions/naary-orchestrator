import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const upsert = vi.fn();
const create = vi.fn();
const settingsUpsert = vi.fn();
const settingsUpdateMany = vi.fn();
const invFindMany = vi.fn();
const invUpdate = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    membership: { findMany, upsert, create },
    tenantSettings: { upsert: settingsUpsert, updateMany: settingsUpdateMany },
    invitation: { findMany: invFindMany, update: invUpdate },
  }),
}));

import { MembershipService } from "../src/membership/membership.service";
import { InMemoryMembershipCache } from "../src/membership/membership-cache";

let cache: InMemoryMembershipCache;
function makeService(): MembershipService {
  cache = new InMemoryMembershipCache();
  return new MembershipService(cache);
}

beforeEach(() => {
  findMany.mockReset();
  upsert.mockReset().mockResolvedValue({});
  create.mockReset().mockResolvedValue({});
  settingsUpsert.mockReset().mockResolvedValue({});
  settingsUpdateMany.mockReset().mockResolvedValue({ count: 0 });
  invFindMany.mockReset().mockResolvedValue([]);
  invUpdate.mockReset().mockResolvedValue({});
});

describe("MembershipService", () => {
  it("reads through the cache: DB on a miss, cached on the next call", async () => {
    findMany.mockResolvedValue([{ tenantId: "t1", role: "owner" }]);
    const svc = makeService();

    expect(await svc.listForUser("u1")).toEqual([
      { tenantId: "t1", role: "owner" },
    ]);
    // second call is served from the cache — the DB is not hit again
    expect(await svc.listForUser("u1")).toEqual([
      { tenantId: "t1", role: "owner" },
    ]);
    expect(findMany).toHaveBeenCalledOnce();
  });

  it("ensureMembership upserts and INVALIDATES the cache (new row seen at once)", async () => {
    findMany.mockResolvedValue([]); // start empty
    const svc = makeService();
    await svc.listForUser("u1"); // populates the cache with []

    await svc.ensureMembership("u1", "t1", "owner", "a@b.co");

    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert.mock.calls[0][0].where).toEqual({
      userId_tenantId: { userId: "u1", tenantId: "t1" },
    });
    // cache was busted, so the next read hits the DB again
    findMany.mockResolvedValue([{ tenantId: "t1", role: "owner" }]);
    expect(await svc.listForUser("u1")).toEqual([
      { tenantId: "t1", role: "owner" },
    ]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("createWorkspace mints a SERVER-random tenantId, owns it, and busts the cache", async () => {
    findMany.mockResolvedValue([]);
    const svc = makeService();
    await svc.listForUser("u1"); // cache []

    const ws = await svc.createWorkspace("u1", "a@b.co");

    // Server-generated id — not attacker-chosen; caller is the owner.
    expect(ws.role).toBe("owner");
    expect(ws.tenantId).toMatch(/^ws-[0-9a-f-]{36}$/);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].data).toMatchObject({
      userId: "u1",
      tenantId: ws.tenantId,
      role: "owner",
      email: "a@b.co",
    });
    // cache busted → the new workspace is visible on the next read
    findMany.mockResolvedValue([{ tenantId: ws.tenantId, role: "owner" }]);
    expect(await svc.listForUser("u1")).toEqual([
      { tenantId: ws.tenantId, role: "owner" },
    ]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("seedWorkspaceName fills a missing name but NEVER overwrites an existing one", async () => {
    await makeService().seedWorkspaceName("t-demo", "  Hassan's workspace  ");
    // Row created if absent — with an empty `update` so an existing name is untouched…
    expect(settingsUpsert).toHaveBeenCalledWith({
      where: { tenantId: "t-demo" },
      create: { tenantId: "t-demo", displayName: "Hassan's workspace" },
      update: {},
    });
    // …and a pre-existing row is only filled when its name is null/empty.
    expect(settingsUpdateMany).toHaveBeenCalledWith({
      where: {
        tenantId: "t-demo",
        OR: [{ displayName: null }, { displayName: "" }],
      },
      data: { displayName: "Hassan's workspace" },
    });
  });

  it("seedWorkspaceName is a no-op on a blank name", async () => {
    await makeService().seedWorkspaceName("t-demo", "   ");
    expect(settingsUpsert).not.toHaveBeenCalled();
    expect(settingsUpdateMany).not.toHaveBeenCalled();
  });

  it("createWorkspace generates a distinct id each call", async () => {
    findMany.mockResolvedValue([]);
    const svc = makeService();
    const a = await svc.createWorkspace("u1");
    const b = await svc.createWorkspace("u1");
    expect(a.tenantId).not.toBe(b.tenantId);
  });
});

// --- Accept-on-login (RBAC-GROUPS.md §5, slice U1) ---
describe("MembershipService.acceptPendingInvitations", () => {
  const invite = {
    id: "inv-1",
    tenantId: "t-inv",
    email: "new@x.com",
    role: "admin",
    acceptedAt: null,
  };

  it("converts a pending invitation: Membership with the invite's role + acceptedAt stamped + cache busted", async () => {
    invFindMany.mockResolvedValue([invite]);
    const svc = makeService();

    await svc.acceptPendingInvitations("u1", "new@x.com", true);

    // Case-insensitive email match, pending only.
    expect(invFindMany.mock.calls[0][0].where).toEqual({
      email: { equals: "new@x.com", mode: "insensitive" },
      acceptedAt: null,
    });
    // Membership created with the INVITE's role; empty update so an existing
    // membership's role WINS (an invitation never re-roles a member).
    expect(upsert).toHaveBeenCalledWith({
      where: { userId_tenantId: { userId: "u1", tenantId: "t-inv" } },
      create: {
        userId: "u1",
        tenantId: "t-inv",
        role: "admin",
        email: "new@x.com",
      },
      update: {},
    });
    expect(invUpdate).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: { acceptedAt: expect.any(Date) },
    });
    // Cache invalidated → the next listForUser hits the DB and sees the new workspace.
    findMany.mockResolvedValue([{ tenantId: "t-inv", role: "admin" }]);
    expect(await svc.listForUser("u1")).toEqual([
      { tenantId: "t-inv", role: "admin" },
    ]);
  });

  it("does NOTHING for an UNVERIFIED email (must never claim an invited address)", async () => {
    invFindMany.mockResolvedValue([invite]);
    const svc = makeService();

    await svc.acceptPendingInvitations("u1", "new@x.com", false);

    expect(invFindMany).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(invUpdate).not.toHaveBeenCalled();
  });

  it("skips the invitation scan while the user's memberships are CACHED (hot path)", async () => {
    findMany.mockResolvedValue([{ tenantId: "t1", role: "owner" }]);
    const svc = makeService();
    await svc.listForUser("u1"); // warm the cache

    await svc.acceptPendingInvitations("u1", "new@x.com", true);

    expect(invFindMany).not.toHaveBeenCalled();
  });

  it("still stamps acceptedAt when a Membership already exists (role kept via empty update)", async () => {
    invFindMany.mockResolvedValue([invite]);
    const svc = makeService();

    await svc.acceptPendingInvitations("u1", "new@x.com", true);

    // upsert's update is {} — a pre-existing membership keeps its own role (no
    // silent escalation from an admin-role invitation).
    expect(upsert.mock.calls[0][0].update).toEqual({});
    expect(invUpdate).toHaveBeenCalledOnce();
  });

  it("is a no-op (no cache invalidation churn) when there are no pending invitations", async () => {
    invFindMany.mockResolvedValue([]);
    const svc = makeService();

    await svc.acceptPendingInvitations("u1", "someone@x.com", true);

    expect(upsert).not.toHaveBeenCalled();
    expect(invUpdate).not.toHaveBeenCalled();
  });
});
