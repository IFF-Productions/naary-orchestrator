import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const upsert = vi.fn();
const create = vi.fn();
const settingsUpsert = vi.fn();
const settingsUpdateMany = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    membership: { findMany, upsert, create },
    tenantSettings: { upsert: settingsUpsert, updateMany: settingsUpdateMany },
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
