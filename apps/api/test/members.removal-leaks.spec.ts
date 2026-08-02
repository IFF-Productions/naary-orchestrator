import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1041 — the member-removal leaks, asserted on STATE rather than on call shapes.
 *
 * `MembersService.removeMember` used to delete the `Membership` and leave the user's
 * `GroupMember` rows behind (no FK protected them — the constraint was a code comment).
 * The rows were inert while the user was gone, because the AuthGuard fails closed without a
 * Membership. The damage landed on RE-INVITE: the returning user silently regained every
 * permission group they had been in, with all its grants, and nobody was shown that it
 * happened.
 *
 * So the headline test below runs the WHOLE round trip — remove → invite → accept-on-login —
 * through the REAL `MembershipService` and asserts the end state: they hold NO group. A
 * `toHaveBeenCalledWith` on a delete would also go red on main, but it would assert the fix's
 * implementation rather than its point, which is the same mistake as the comment.
 *
 * The prisma double here is STATEFUL (real rows in arrays) for exactly that reason. It cannot
 * exercise the database constraint that is the durable half of the fix — that is proven
 * against a real Postgres in the PR body (cascade fires, non-member INSERT rejected).
 */

interface MembershipRow {
  id: string;
  userId: string;
  tenantId: string;
  role: string;
  email: string | null;
  createdAt: Date;
  lastActiveAt: Date | null;
}
interface GroupMemberRow {
  groupId: string;
  userId: string;
  tenantId: string | null;
}
interface GroupRow {
  id: string;
  tenantId: string;
}
interface InvitationRow {
  id: string;
  tenantId: string;
  email: string;
  role: string;
  groupIds: string[] | null;
  invitedBy: string;
  createdAt: Date;
  acceptedAt: Date | null;
}

const db = {
  memberships: [] as MembershipRow[],
  groupMembers: [] as GroupMemberRow[],
  groups: [] as GroupRow[],
  invitations: [] as InvitationRow[],
};

const eqi = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/** The subset of the Prisma surface these two services touch, backed by the arrays above. */
const prisma = {
  $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  membership: {
    findUnique: async ({ where }: any) => {
      const { userId, tenantId } = where.userId_tenantId;
      return (
        db.memberships.find(
          (m) => m.userId === userId && m.tenantId === tenantId,
        ) ?? null
      );
    },
    findFirst: async ({ where }: any) =>
      db.memberships.find(
        (m) =>
          m.tenantId === where.tenantId &&
          (where.email ? eqi(m.email, where.email.equals) : true),
      ) ?? null,
    findMany: async ({ where }: any) =>
      db.memberships.filter((m) =>
        where?.tenantId ? m.tenantId === where.tenantId : true,
      ),
    count: async ({ where }: any) =>
      db.memberships.filter(
        (m) => m.tenantId === where.tenantId && m.role === where.role,
      ).length,
    deleteMany: async ({ where }: any) => {
      const before = db.memberships.length;
      db.memberships = db.memberships.filter(
        (m) => !(m.userId === where.userId && m.tenantId === where.tenantId),
      );
      return { count: before - db.memberships.length };
    },
    update: async ({ where, data }: any) => {
      const { userId, tenantId } = where.userId_tenantId;
      const row = db.memberships.find(
        (m) => m.userId === userId && m.tenantId === tenantId,
      )!;
      Object.assign(row, data);
      return row;
    },
    upsert: async ({ where, create }: any) => {
      const { userId, tenantId } = where.userId_tenantId;
      const found = db.memberships.find(
        (m) => m.userId === userId && m.tenantId === tenantId,
      );
      if (found) return found; // `update: {}` — an existing role always wins
      const row: MembershipRow = {
        id: `m-${db.memberships.length + 1}`,
        userId: create.userId,
        tenantId: create.tenantId,
        role: create.role,
        email: create.email ?? null,
        createdAt: new Date(),
        lastActiveAt: null,
      };
      db.memberships.push(row);
      return row;
    },
  },
  groupMember: {
    // Mirrors the real filter: `{ userId, group: { tenantId } }` — the group relation is what
    // scopes the delete to ONE workspace.
    deleteMany: async ({ where }: any) => {
      const before = db.groupMembers.length;
      db.groupMembers = db.groupMembers.filter((gm) => {
        if (gm.userId !== where.userId) return true;
        if (where.group?.tenantId === undefined) return false;
        const g = db.groups.find((x) => x.id === gm.groupId);
        return g?.tenantId !== where.group.tenantId;
      });
      return { count: before - db.groupMembers.length };
    },
    createMany: async ({ data }: any) => {
      for (const d of data) {
        if (
          !db.groupMembers.some(
            (gm) => gm.groupId === d.groupId && gm.userId === d.userId,
          )
        ) {
          db.groupMembers.push({
            groupId: d.groupId,
            userId: d.userId,
            tenantId: d.tenantId ?? null,
          });
        }
      }
      return { count: data.length };
    },
  },
  permissionGroup: {
    findMany: async ({ where }: any) =>
      db.groups.filter(
        (g) => g.tenantId === where.tenantId && where.id.in.includes(g.id),
      ),
  },
  invitation: {
    findUnique: async ({ where }: any) =>
      db.invitations.find(
        (i) =>
          i.tenantId === where.tenantId_email.tenantId &&
          i.email === where.tenantId_email.email,
      ) ?? null,
    findFirst: async () => null,
    findMany: async ({ where }: any) =>
      db.invitations.filter(
        (i) =>
          eqi(i.email, where.email.equals) &&
          i.acceptedAt === null &&
          (where.tenantId ? i.tenantId === where.tenantId : true),
      ),
    create: async ({ data }: any) => {
      const row: InvitationRow = {
        id: `inv-${db.invitations.length + 1}`,
        tenantId: data.tenantId,
        email: data.email,
        role: data.role,
        groupIds: data.groupIds ?? null,
        invitedBy: data.invitedBy,
        createdAt: new Date(),
        acceptedAt: null,
      };
      db.invitations.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = db.invitations.find((i) => i.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
    deleteMany: async () => ({ count: 0 }),
  },
  tenantSettings: { findUnique: async () => ({ displayName: "Acme" }) },
};

vi.mock("@naary/db", () => ({ getPrisma: () => prisma }));

import type { Principal } from "../src/auth/tenant.decorator";
import type { MailerService } from "../src/mail/mailer.service";
import type { MembershipCache } from "../src/membership/membership-cache";
import { MembershipService } from "../src/membership/membership.service";
import { MembersService } from "../src/members/members.service";
import type { PermissionsService } from "../src/permissions/permissions.service";

const invalidateTenant = vi.fn();
const sendInvitation = vi.fn().mockResolvedValue(true);

/** Always a MISS — `acceptPendingInvitations` short-circuits on a cache HIT. */
const cache: MembershipCache = {
  get: () => undefined,
  set: () => undefined,
  invalidate: () => undefined,
} as unknown as MembershipCache;

const memberships = new MembershipService(cache);
const svc = new MembersService(
  memberships,
  { sendInvitation } as unknown as MailerService,
  { invalidateTenant } as unknown as PermissionsService,
);

const asOwner: Principal = { tenantId: "t-1", userId: "u-own", role: "owner" };

/** The full re-add round trip: invite the removed user, then sign them in. */
async function reAdd(tenantId: string, email: string, userId: string) {
  await svc.invite(tenantId, asOwner, email, "member");
  await memberships.acceptPendingInvitations(userId, email, true);
}

const groupsOf = (userId: string, tenantId: string) =>
  db.groupMembers.filter(
    (gm) =>
      gm.userId === userId &&
      db.groups.find((g) => g.id === gm.groupId)?.tenantId === tenantId,
  );

beforeEach(() => {
  invalidateTenant.mockReset();
  sendInvitation.mockReset().mockResolvedValue(true);
  db.memberships = [
    {
      id: "m-own",
      userId: "u-own",
      tenantId: "t-1",
      role: "owner",
      email: "own@x.com",
      createdAt: new Date(),
      lastActiveAt: null,
    },
    {
      id: "m-own2",
      userId: "u-own2",
      tenantId: "t-1",
      role: "owner",
      email: "own2@x.com",
      createdAt: new Date(),
      lastActiveAt: null,
    },
    {
      id: "m-1",
      userId: "u-1",
      tenantId: "t-1",
      role: "member",
      email: "kim@x.com",
      createdAt: new Date(),
      lastActiveAt: null,
    },
  ];
  db.groups = [
    { id: "g-deployers", tenantId: "t-1" },
    { id: "g-finance", tenantId: "t-1" },
  ];
  db.groupMembers = [
    { groupId: "g-deployers", userId: "u-1", tenantId: "t-1" },
    { groupId: "g-finance", userId: "u-1", tenantId: "t-1" },
  ];
  db.invitations = [];
});

describe("#1041 — removing a member must not leave orphan GroupMember rows", () => {
  it("a removed member RE-ADDED later holds NO permission group", async () => {
    expect(groupsOf("u-1", "t-1")).toHaveLength(2); // before: two groups

    await svc.removeMember("t-1", asOwner, "u-1");
    await reAdd("t-1", "kim@x.com", "u-1");

    // They are a member again…
    expect(
      db.memberships.some((m) => m.userId === "u-1" && m.tenantId === "t-1"),
    ).toBe(true);
    // …and hold nothing they were not re-granted. THE assertion: silent privilege
    // restoration is what this issue is about.
    expect(groupsOf("u-1", "t-1")).toEqual([]);
  });

  it("removal drops the group rows immediately, not just on re-add", async () => {
    await svc.removeMember("t-1", asOwner, "u-1");
    expect(groupsOf("u-1", "t-1")).toEqual([]);
  });

  it("only THIS workspace's groups go — a shared uid keeps its other workspaces", async () => {
    db.memberships.push({
      id: "m-2",
      userId: "u-1",
      tenantId: "t-2",
      role: "member",
      email: "kim@x.com",
      createdAt: new Date(),
      lastActiveAt: null,
    });
    db.groups.push({ id: "g-other", tenantId: "t-2" });
    db.groupMembers.push({
      groupId: "g-other",
      userId: "u-1",
      tenantId: "t-2",
    });

    await svc.removeMember("t-1", asOwner, "u-1");

    expect(groupsOf("u-1", "t-1")).toEqual([]);
    expect(groupsOf("u-1", "t-2")).toHaveLength(1); // untouched
    expect(
      db.memberships.some((m) => m.userId === "u-1" && m.tenantId === "t-2"),
    ).toBe(true);
  });

  it("a refused removal (last owner) deletes nothing at all", async () => {
    db.memberships = db.memberships.filter((m) => m.userId !== "u-own2");
    db.groupMembers.push({
      groupId: "g-finance",
      userId: "u-own",
      tenantId: "t-1",
    });
    await expect(svc.removeMember("t-1", asOwner, "u-own")).rejects.toThrow();
    expect(groupsOf("u-own", "t-1")).toHaveLength(1);
    expect(db.memberships.some((m) => m.userId === "u-own")).toBe(true);
  });
});

describe("#1041 — the permission cache must not outlive the membership", () => {
  it("removal invalidates the tenant's permission cache", async () => {
    await svc.removeMember("t-1", asOwner, "u-1");
    expect(invalidateTenant).toHaveBeenCalledWith("t-1");
  });

  it("a no-op removal (unknown uid) invalidates nothing", async () => {
    await svc.removeMember("t-1", asOwner, "u-ghost");
    expect(invalidateTenant).not.toHaveBeenCalled();
  });

  it("a role change invalidates it too — it crosses the §4 bypass line", async () => {
    await svc.changeRole("t-1", asOwner, "u-1", "admin");
    expect(invalidateTenant).toHaveBeenCalledWith("t-1");
  });
});

describe("#1041 — accept-on-login stamps the FK's tenantId", () => {
  it("group rows written on accept carry the invitation's tenant", async () => {
    db.memberships = db.memberships.filter((m) => m.userId !== "u-1");
    db.groupMembers = [];
    db.invitations = [
      {
        id: "inv-1",
        tenantId: "t-1",
        email: "kim@x.com",
        role: "member",
        groupIds: ["g-deployers"],
        invitedBy: "u-own",
        createdAt: new Date(),
        acceptedAt: null,
      },
    ];
    await memberships.acceptPendingInvitations("u-1", "kim@x.com", true);
    // Without tenantId the row is exempt from the composite FK (MATCH SIMPLE) — i.e. it
    // would be a fresh orphan-in-waiting the moment the membership goes.
    expect(db.groupMembers).toEqual([
      { groupId: "g-deployers", userId: "u-1", tenantId: "t-1" },
    ]);
  });
});
