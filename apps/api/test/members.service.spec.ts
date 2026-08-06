import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const membership = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
  count: vi.fn(),
};
const invitation = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
};
const tenantSettings = { findUnique: vi.fn() };
const groupMember = { deleteMany: vi.fn(), findMany: vi.fn() };
/** Resolves what it is handed — a bare vi.fn() would silently swallow the batched deletes. */
const $transaction = vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops));
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    membership,
    invitation,
    tenantSettings,
    groupMember,
    $transaction,
  }),
}));

import type { Principal } from "../src/auth/tenant.decorator";
import type { AuditService } from "../src/audit/audit.service";
import type { ApiTokenService } from "../src/auth/api-token.service";
import type { CliRefreshTokenService } from "../src/auth/cli-refresh-token.service";
import type { ExecutionsService } from "../src/executions/executions.service";
import type { MailerService } from "../src/mail/mailer.service";
import type { MembershipService } from "../src/membership/membership.service";
import { MembersService } from "../src/members/members.service";
import type { PermissionsService } from "../src/permissions/permissions.service";

const invalidate = vi.fn();
const sendInvitation = vi.fn();
const invalidateTenant = vi.fn();
/** #1053 — the post-removal stranded-approval read. Nothing here exercises it (see
 *  members.stranded-approvals.spec.ts); "no paused runs" is the quiet default. */
const heldApprovals = vi.fn().mockResolvedValue({
  total: 0,
  needsOwnerOrAdmin: 0,
  partial: false,
  runs: [],
});
const record = vi.fn().mockResolvedValue(undefined);
/** #1117 — offboarding kills the user's CLI refresh families. Exercised for real (through the
 *  REAL service, ending in a rejected rotate) in members.cli-session-revocation.spec.ts; here it
 *  is a quiet stub, because every remove/demote in this file would otherwise call into it. */
const revokeUserSessions = vi
  .fn()
  .mockResolvedValue({ families: 0, tokens: 0 });
/** #1118's residual — the same offboarding call deletes the live CLI ACCESS token. Also a quiet
 *  stub here, and also PRESENT rather than omitted: `revokeCliSessions` catches its own failures,
 *  so a missing delegate would be a TypeError this file absorbed without a red test. The real
 *  behaviour is pinned in cli-access-token-revocation.spec.ts. */
const revokeUserCliTokens = vi.fn().mockResolvedValue(0);
const svc = new MembersService(
  { invalidate } as unknown as MembershipService,
  { sendInvitation } as unknown as MailerService,
  { invalidateTenant } as unknown as PermissionsService,
  { heldApprovals } as unknown as ExecutionsService,
  { record } as unknown as AuditService,
  { revokeUserSessions } as unknown as CliRefreshTokenService,
  { revokeUserCliTokens } as unknown as ApiTokenService,
);

/** The invite email is fire-and-forget (void) — flush microtasks so the async IIFE settles. */
const flush = () => new Promise((r) => setImmediate(r));

const now = new Date("2026-01-01T00:00:00.000Z");
const asOwner: Principal = { tenantId: "t-1", userId: "u-own", role: "owner" };
const asAdmin: Principal = { tenantId: "t-1", userId: "u-adm", role: "admin" };
const asMember: Principal = {
  tenantId: "t-1",
  userId: "u-mem",
  role: "member",
};

beforeEach(() => {
  for (const m of [
    ...Object.values(membership),
    ...Object.values(invitation),
    tenantSettings.findUnique,
    groupMember.deleteMany,
    groupMember.findMany,
    invalidate,
    invalidateTenant,
    sendInvitation,
  ]) {
    m.mockReset();
  }
  groupMember.deleteMany.mockResolvedValue({ count: 0 });
  groupMember.findMany.mockResolvedValue([]); // #1053 — approver identity read
  membership.findMany.mockResolvedValue([]);
  membership.findFirst.mockResolvedValue(null);
  membership.findUnique.mockResolvedValue(null);
  membership.count.mockResolvedValue(2); // two owners by default — last-owner guard quiet
  membership.deleteMany.mockResolvedValue({ count: 1 });
  invitation.findMany.mockResolvedValue([]);
  invitation.findFirst.mockResolvedValue(null);
  invitation.findUnique.mockResolvedValue(null);
  invitation.deleteMany.mockResolvedValue({ count: 1 });
  tenantSettings.findUnique.mockResolvedValue({ displayName: "Acme Prod" });
  sendInvitation.mockResolvedValue(true);
});

describe("MembersService.list", () => {
  it("returns Membership rows ∪ pending invitations with a status discriminator", async () => {
    membership.findMany.mockResolvedValue([
      {
        userId: "u-1",
        email: "a@x.com",
        role: "owner",
        createdAt: now,
        lastActiveAt: now,
      },
    ]);
    invitation.findMany.mockResolvedValue([
      { id: "inv-1", email: "b@x.com", role: "member", createdAt: now },
    ]);
    expect(await svc.list("t-1")).toEqual([
      {
        id: "u-1",
        userId: "u-1",
        email: "a@x.com",
        role: "owner",
        status: "active",
        // #1115 — the Team screen has to be able to show a deactivated member AS deactivated,
        // because workspace-side removal is the documented escape hatch.
        active: true,
        createdAt: now.toISOString(),
        lastActiveAt: now.toISOString(),
      },
      {
        id: "inv-1",
        email: "b@x.com",
        role: "member",
        status: "invited",
        createdAt: now.toISOString(),
      },
    ]);
    // Only PENDING invitations appear (accepted ones are represented by their Membership).
    expect(invitation.findMany.mock.calls[0][0].where).toEqual({
      tenantId: "t-1",
      acceptedAt: null,
    });
  });
});

describe("MembersService.invite", () => {
  it("creates a pending Invitation (lowercased email) — NOT a Membership", async () => {
    invitation.create.mockResolvedValue({
      id: "inv-1",
      email: "new@x.com",
      role: "member",
      createdAt: now,
    });
    const v = await svc.invite("t-1", asOwner, "  New@X.com ", "member");
    expect(v).toMatchObject({ id: "inv-1", status: "invited" });
    expect(invitation.create.mock.calls[0][0].data).toEqual({
      tenantId: "t-1",
      email: "new@x.com",
      role: "member",
      invitedBy: "u-own",
    });
  });

  it("sends an invitation email (#468) to the lowercased address with the workspace name", async () => {
    invitation.create.mockResolvedValue({
      id: "inv-1",
      email: "new@x.com",
      role: "member",
      createdAt: now,
    });
    await svc.invite("t-1", asOwner, "  New@X.com ", "member");
    await flush(); // fire-and-forget email
    expect(sendInvitation).toHaveBeenCalledTimes(1);
    expect(sendInvitation.mock.calls[0][0]).toMatchObject({
      to: "new@x.com",
      workspaceName: "Acme Prod",
    });
    expect(sendInvitation.mock.calls[0][0].signInUrl).toContain("/auth");
  });

  it("still succeeds when the invite email fails (best-effort, never blocks the invite)", async () => {
    invitation.create.mockResolvedValue({
      id: "inv-1",
      email: "new@x.com",
      role: "member",
      createdAt: now,
    });
    sendInvitation.mockRejectedValue(new Error("smtp down"));
    tenantSettings.findUnique.mockRejectedValue(new Error("db blip"));
    const v = await svc.invite("t-1", asOwner, "new@x.com", "member");
    await flush();
    expect(v).toMatchObject({ id: "inv-1", status: "invited" }); // invite unaffected
  });

  it("409s when the email already belongs to an active member", async () => {
    membership.findFirst.mockResolvedValue({ userId: "u-9" });
    await expect(
      svc.invite("t-1", asOwner, "a@x.com", "member"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(invitation.create).not.toHaveBeenCalled();
  });

  it("409s when an invitation for the email is already pending", async () => {
    invitation.findUnique.mockResolvedValue({ id: "inv-1", acceptedAt: null });
    await expect(
      svc.invite("t-1", asOwner, "b@x.com", "member"),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("re-opens a previously ACCEPTED invitation when the membership is gone", async () => {
    invitation.findUnique.mockResolvedValue({ id: "inv-1", acceptedAt: now });
    invitation.update.mockResolvedValue({
      id: "inv-1",
      email: "b@x.com",
      role: "admin",
      createdAt: now,
    });
    const v = await svc.invite("t-1", asOwner, "b@x.com", "admin");
    expect(v.status).toBe("invited");
    expect(invitation.update.mock.calls[0][0].data).toMatchObject({
      role: "admin",
      acceptedAt: null,
    });
    expect(invitation.create).not.toHaveBeenCalled();
  });

  it("maps a P2002 create race to 409, not 500", async () => {
    invitation.create.mockRejectedValue(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );
    await expect(
      svc.invite("t-1", asOwner, "c@x.com", "member"),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // --- §4 role gates ---

  it("403s a plain member trying to invite", async () => {
    await expect(
      svc.invite("t-1", asMember, "x@x.com", "member"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(invitation.create).not.toHaveBeenCalled();
  });

  it("lets an admin invite a MEMBER", async () => {
    invitation.create.mockResolvedValue({
      id: "inv-2",
      email: "x@x.com",
      role: "member",
      createdAt: now,
    });
    await expect(
      svc.invite("t-1", asAdmin, "x@x.com", "member"),
    ).resolves.toMatchObject({ status: "invited" });
  });

  it("403s an admin inviting as ADMIN (elevated grants are owner-only)", async () => {
    await expect(
      svc.invite("t-1", asAdmin, "x@x.com", "admin"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("lets the owner invite as admin", async () => {
    invitation.create.mockResolvedValue({
      id: "inv-3",
      email: "x@x.com",
      role: "admin",
      createdAt: now,
    });
    await expect(
      svc.invite("t-1", asOwner, "x@x.com", "admin"),
    ).resolves.toMatchObject({ role: "admin" });
  });
});

describe("MembersService.changeRole", () => {
  it("updates the role and INVALIDATES the target's membership cache", async () => {
    membership.findUnique.mockResolvedValue({ userId: "u-2", role: "member" });
    membership.update.mockResolvedValue({
      userId: "u-2",
      email: "b@x.com",
      role: "admin",
      createdAt: now,
    });
    const v = await svc.changeRole("t-1", asOwner, "u-2", "admin");
    expect(v).toMatchObject({ role: "admin", status: "active" });
    expect(invalidate).toHaveBeenCalledWith("u-2");
  });

  it("404s on an unknown member", async () => {
    await expect(
      svc.changeRole("t-1", asOwner, "u-ghost", "admin"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("403s a member caller", async () => {
    await expect(
      svc.changeRole("t-1", asMember, "u-2", "member"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("403s an admin GRANTING admin (owner-only)", async () => {
    membership.findUnique.mockResolvedValue({ userId: "u-2", role: "member" });
    await expect(
      svc.changeRole("t-1", asAdmin, "u-2", "admin"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("403s an admin DEMOTING an admin (revoking elevated is owner-only)", async () => {
    membership.findUnique.mockResolvedValue({ userId: "u-2", role: "admin" });
    await expect(
      svc.changeRole("t-1", asAdmin, "u-2", "member"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("409s demoting the LAST owner", async () => {
    membership.findUnique.mockResolvedValue({ userId: "u-own", role: "owner" });
    membership.count.mockResolvedValue(1);
    await expect(
      svc.changeRole("t-1", asOwner, "u-own", "member"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(membership.update).not.toHaveBeenCalled();
  });
});

describe("MembersService.removeMember", () => {
  it("deletes tenant-scoped and INVALIDATES the removed user's cache", async () => {
    membership.findUnique.mockResolvedValue({ userId: "u-2", role: "member" });
    await svc.removeMember("t-1", asAdmin, "u-2");
    expect(membership.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: "t-1", userId: "u-2" },
    });
    expect(invalidate).toHaveBeenCalledWith("u-2");
  });

  it("is a no-op on an unknown uid (never a cross-tenant delete or a 500)", async () => {
    await svc.removeMember("t-1", asOwner, "u-ghost");
    expect(membership.deleteMany).not.toHaveBeenCalled();
  });

  it("403s a member caller", async () => {
    await expect(
      svc.removeMember("t-1", asMember, "u-2"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("403s an admin removing an ADMIN (owner-only)", async () => {
    membership.findUnique.mockResolvedValue({ userId: "u-2", role: "admin" });
    await expect(
      svc.removeMember("t-1", asAdmin, "u-2"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("409s removing the LAST owner", async () => {
    membership.findUnique.mockResolvedValue({ userId: "u-own", role: "owner" });
    membership.count.mockResolvedValue(1);
    await expect(
      svc.removeMember("t-1", asOwner, "u-own"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(membership.deleteMany).not.toHaveBeenCalled();
  });

  it("allows removing an owner when ANOTHER owner remains", async () => {
    membership.findUnique.mockResolvedValue({ userId: "u-2", role: "owner" });
    membership.count.mockResolvedValue(2);
    await svc.removeMember("t-1", asOwner, "u-2");
    expect(membership.deleteMany).toHaveBeenCalled();
  });
});

describe("MembersService.revokeInvitation", () => {
  it("revokes a pending invitation (tenant-scoped)", async () => {
    invitation.findFirst.mockResolvedValue({ id: "inv-1", role: "member" });
    await svc.revokeInvitation("t-1", asAdmin, "inv-1");
    expect(invitation.deleteMany).toHaveBeenCalledWith({
      where: { id: "inv-1", tenantId: "t-1", acceptedAt: null },
    });
  });

  it("is a no-op on an unknown/accepted invitation", async () => {
    await svc.revokeInvitation("t-1", asOwner, "inv-ghost");
    expect(invitation.deleteMany).not.toHaveBeenCalled();
  });

  it("403s a member caller", async () => {
    await expect(
      svc.revokeInvitation("t-1", asMember, "inv-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("403s an admin revoking an ADMIN invitation (owner-only)", async () => {
    invitation.findFirst.mockResolvedValue({ id: "inv-1", role: "admin" });
    await expect(
      svc.revokeInvitation("t-1", asAdmin, "inv-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(invitation.deleteMany).not.toHaveBeenCalled();
  });
});
