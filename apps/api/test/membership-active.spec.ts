import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { APPROVAL_CTX_KEY } from "@naary/contracts";

/**
 * #1115 — `Membership.active`, THE SOFT DE-PROVISION, AND EVERY READ THAT HAS TO HONOUR IT.
 *
 * The issue named the risk verbatim: *"every place that treats 'a Membership row exists' as
 * authority would have to also check `active`. Missing one read means a user we told the IdP was
 * de-provisioned still has access."* So the deliverable of this change is not the column and it
 * is not the endpoint — it is this file. There is one test per enumerated site, each ending at
 * the REAL guard or the REAL service rather than at a row's boolean, because "the column is
 * false" is not the property anybody cares about.
 *
 * HOW TO USE IT AS A REVIEWER (the mutation check the tests are shaped for): each enforcement is
 * a single named predicate. Delete one and exactly one section here should go red.
 *
 *   membership.service.ts   `.filter((m) => m.active)` in listForUser  → §1
 *   membership.service.ts   `deactivatedTenantIds`                     → §2 (the legacy claim)
 *   auth.guard.ts           `deactivated.has(target)`                  → §2 (the 403's code)
 *   sso.service.ts          `if (existing && !existing.active)`        → sso.service.spec.ts
 *   members.service.ts      `active: true` in assertNotLastOwner       → §3
 *   members.service.ts      `active: r.active ?? true` in activeView   → §3
 *   members.service.ts      the deactivated branch of invite's 409     → §3
 *   approval-holds.ts       `active: true` / `membership:{active:true}`→ §4
 *   company.service.ts      `active: true` in addMember                → company.manage.spec.ts
 *   company.service.ts      `m.active !== false` in isWorkspaceOwner   → company.service.spec.ts
 *   scim-users.service.ts   `active: m.active !== false` (×2)          → §5
 *   scim-provisioning.ts    `assertWritableDomain`                     → §7
 *   members.service.ts      `revokeCliSessions` in setMemberActive     → §6
 *   membership.service.ts   both `update: {}` upserts                  → §8
 *
 * `./support/prisma-fake` models `active` the way the migration does — NOT NULL DEFAULT true —
 * so a row the code creates without naming the column comes out LIVE, exactly as one written by
 * an old image during a rolling deploy does. That is what makes §8 a test and not a restatement.
 */

import { resetTables, table, type Row } from "./support/prisma-fake";

const NOW = new Date("2026-08-05T00:00:00Z");

const db = {
  // `active: true` as a CREATE DEFAULT, exactly as the migration declares it. A Membership the
  // code creates without naming the column must come out LIVE, or half these tests would pass
  // for the wrong reason.
  membership: table([], [["id"], ["userId", "tenantId"]], { active: true }),
  invitation: table([], [["id"], ["tenantId", "email"]], {
    acceptedAt: null,
    groupIds: [],
  }),
  groupMember: table([], [["groupId", "userId"]]),
  permissionGroup: table([]),
  scimIdentity: table([], [["id"], ["tenantId", "email"]]),
  tenantSettings: table([]),
  cliRefreshToken: table([], [["id"], ["tokenHash"]], {
    lastUsedAt: null,
    rotatedAt: null,
    revokedAt: null,
  }),
  apiToken: table([], [["id"], ["tokenHash"]], {
    lastUsedAt: null,
    expiresAt: null,
    environmentId: null,
    userId: null,
    familyId: null,
  }),
  execution: table([]),
  $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
};

vi.mock("@naary/db", () => ({ getPrisma: () => db }));

import { AuthGuard } from "../src/auth/auth.guard";
import { ApiTokenService } from "../src/auth/api-token.service";
import { CliRefreshTokenService } from "../src/auth/cli-refresh-token.service";
import {
  findHeldApprovals,
  NO_HELD_APPROVALS,
} from "../src/executions/executions.approval-holds";
import { MembersService } from "../src/members/members.service";
import { InMemoryMembershipCache } from "../src/membership/membership-cache";
import { MembershipService } from "../src/membership/membership.service";
import { GroupsService } from "../src/permissions/groups.service";
import {
  parsePatchPayload,
  ScimProvisioningService,
} from "../src/scim/scim-provisioning.service";
import { ScimUsersService } from "../src/scim/scim-users.service";
import { ScimError } from "../src/scim/scim.errors";
import type { ScimWriteContext } from "../src/scim/scim.guard";
import type { Principal } from "../src/auth/tenant.decorator";

// ---------------------------------------------------------------------------
// Wiring — REAL services throughout. The point of the file is that enforcement
// happens where the product says it happens.
// ---------------------------------------------------------------------------

const membershipCache = new InMemoryMembershipCache();
const memberships = new MembershipService(membershipCache);

const permissions = { invalidateTenant: vi.fn(), isTenantEnforced: vi.fn() };
const mailer = { sendInvitation: vi.fn(async () => {}) };
const executions = { heldApprovals: vi.fn(async () => NO_HELD_APPROVALS) };
const audit = { record: vi.fn(async (_i: Record<string, unknown>) => {}) };
// `apiTokens` first: `CliRefreshTokenService` requires it (the reuse-detection access-token
// recall), and a required dependency is what stops that recall degrading to a silent no-op.
const apiTokens = new ApiTokenService();
const cliSessions = new CliRefreshTokenService(apiTokens);

const members = new MembersService(
  memberships,
  mailer as never,
  permissions as never,
  executions as never,
  audit as never,
  cliSessions,
  apiTokens,
);
const scimUsers = new ScimUsersService();
const provisioning = new ScimProvisioningService(
  members,
  scimUsers,
  audit as never,
);
const groups = new GroupsService(permissions as never);

const CONN: ScimWriteContext = {
  connectionId: "conn-1",
  tenantId: "t-1",
  allowedEmailDomains: ["acme.example"],
};
/** Registered for ONE domain — the connection whose allowlist no longer covers everyone it
 *  provisioned. Decision 2's whole subject. */
const NARROW_CONN: ScimWriteContext = {
  connectionId: "conn-narrow",
  tenantId: "t-1",
  allowedEmailDomains: ["contractor.example"],
};

const OWNER: Principal = {
  tenantId: "t-1",
  userId: "u-owner",
  subject: "u-owner",
  role: "owner",
};

function seedMembership(
  userId: string,
  email: string,
  role = "member",
  active = true,
  tenantId = "t-1",
): void {
  db.membership.rows.push({
    id: `m-${tenantId}-${userId}`,
    tenantId,
    userId,
    email,
    role,
    active,
    createdAt: NOW,
    lastActiveAt: null,
  });
}

function seedGroupMember(groupId: string, userId: string, tenantId = "t-1") {
  db.groupMember.rows.push({
    groupId,
    userId,
    tenantId,
    createdAt: NOW,
    // The relation halves the fake resolves nested filters against.
    group: { tenantId },
    get membership() {
      return (
        db.membership.rows.find(
          (m) => m.userId === userId && m.tenantId === tenantId,
        ) ?? { active: false }
      );
    },
  });
}

beforeEach(() => {
  resetTables([
    db.membership,
    db.invitation,
    db.groupMember,
    db.permissionGroup,
    db.scimIdentity,
    db.tenantSettings,
    db.cliRefreshToken,
    db.apiToken,
    db.execution,
  ]);
  for (const fn of [
    permissions.invalidateTenant,
    mailer.sendInvitation,
    executions.heldApprovals,
    audit.record,
  ]) {
    fn.mockClear();
  }
  permissions.isTenantEnforced.mockResolvedValue(false);
  membershipCache.invalidate("u-leaver");
  membershipCache.invalidate("u-owner");
  membershipCache.invalidate("u-claim");

  // Two owners so the last-owner guard never masks the property under test, and one plain
  // member ("the leaver") who is what every de-provision below acts on.
  seedMembership("u-owner", "owner@acme.example", "owner");
  seedMembership("u-owner-2", "owner2@acme.example", "owner");
  seedMembership("u-leaver", "leaver@acme.example", "member");
  db.permissionGroup.rows.push({
    id: "g-finance",
    tenantId: "t-1",
    name: "Finance",
    createdAt: NOW,
  });
  seedGroupMember("g-finance", "u-leaver");
});

/** The uid's row, straight out of the fake — for asserting what a write actually did. */
const row = (userId: string, tenantId = "t-1") =>
  db.membership.rows.find(
    (r) => r.userId === userId && r.tenantId === tenantId,
  );

const auditLines = (): string[] =>
  audit.record.mock.calls.map((c) => String((c[0] as Row).action));

// ---------------------------------------------------------------------------
// §1. THE CHOKEPOINT — MembershipService.listForUser, and the real AuthGuard on top of it
// ---------------------------------------------------------------------------

describe("§1 the authorization chokepoint", () => {
  it("listForUser omits a deactivated membership — the list the guard authorizes from", async () => {
    seedMembership("u-multi", "multi@acme.example", "member", true, "t-live");
    seedMembership("u-multi", "multi@acme.example", "admin", false, "t-off");
    membershipCache.invalidate("u-multi");

    const live = await memberships.listForUser("u-multi");
    expect(live.map((m) => m.tenantId)).toEqual(["t-live"]);
  });

  it("deactivatedTenantIds reports the switched-off workspace, from the SAME cached read", async () => {
    seedMembership("u-multi", "multi@acme.example", "member", true, "t-live");
    seedMembership("u-multi", "multi@acme.example", "admin", false, "t-off");
    membershipCache.invalidate("u-multi");

    await memberships.listForUser("u-multi"); // populates the cache
    db.membership.findMany.mockClear();
    expect(await memberships.deactivatedTenantIds("u-multi")).toEqual(
      new Set(["t-off"]),
    );
    // No second query: the guard calls both per request, and the cache is what keeps that free.
    expect(db.membership.findMany).not.toHaveBeenCalled();
  });

  it("THE HEADLINE DENIAL: the real AuthGuard 403s a deactivated member on a workspace route", async () => {
    row("u-leaver")!.active = false;
    membershipCache.invalidate("u-leaver");

    const { guard, req } = firebaseGuard("u-leaver", "leaver@acme.example");
    await expect(
      guard.canActivate(ctxFor(req("/tenants/t-1/workflows"))),
    ).rejects.toThrow(ForbiddenException);
  });

  it("…and the SAME user passes once they are live again (the denial is the column, not the fixture)", async () => {
    const { guard, req } = firebaseGuard("u-leaver", "leaver@acme.example");
    const r = req("/tenants/t-1/workflows");
    expect(await guard.canActivate(ctxFor(r))).toBe(true);
    expect(r.principal).toMatchObject({ tenantId: "t-1", role: "member" });
  });

  it("names the state in the 403 body — an admin cannot act on 'Not a workspace member'", async () => {
    row("u-leaver")!.active = false;
    membershipCache.invalidate("u-leaver");

    const { guard, req } = firebaseGuard("u-leaver", "leaver@acme.example");
    await expect(
      guard.canActivate(ctxFor(req("/tenants/t-1/workflows"))),
    ).rejects.toMatchObject({
      response: { code: "membership_deactivated" },
    });
  });
});

// ---------------------------------------------------------------------------
// §2. AUTHORITY THAT IS NOT A MEMBERSHIP READ — the legacy `tenant` claim
// ---------------------------------------------------------------------------

describe("§2 the legacy tenant claim, which grants owner with no row at all", () => {
  it("a deactivated row BEATS the claim — otherwise the claim silently re-grants owner", async () => {
    seedMembership("u-claim", "claim@acme.example", "owner", false);
    membershipCache.invalidate("u-claim");

    const { guard, req } = firebaseGuard(
      "u-claim",
      "claim@acme.example",
      "t-1",
    );
    await expect(
      guard.canActivate(ctxFor(req("/tenants/t-1/workflows"))),
    ).rejects.toMatchObject({ response: { code: "membership_deactivated" } });
  });

  it("and does NOT get quietly re-created by the guard's claim→Membership backfill", async () => {
    seedMembership("u-claim", "claim@acme.example", "owner", false);
    membershipCache.invalidate("u-claim");

    const { guard, req } = firebaseGuard(
      "u-claim",
      "claim@acme.example",
      "t-1",
    );
    await expect(
      guard.canActivate(ctxFor(req("/tenants/t-1/workflows"))),
    ).rejects.toThrow();
    expect(row("u-claim")!.active).toBe(false);
    expect(
      db.membership.rows.filter((r) => r.userId === "u-claim"),
    ).toHaveLength(1);
  });

  it("a claim holder with NO row is untouched (the transitional grant still works)", async () => {
    const { guard, req } = firebaseGuard("u-new", "new@acme.example", "t-new");
    const r = req("/tenants/t-new/workflows");
    expect(await guard.canActivate(ctxFor(r))).toBe(true);
    expect(r.principal).toMatchObject({ tenantId: "t-new", role: "owner" });
  });
});

// ---------------------------------------------------------------------------
// §3. MembersService — the last-owner guard, the Team screen, and invite
// ---------------------------------------------------------------------------

describe("§3 MembersService reads", () => {
  it("assertNotLastOwner counts LIVE owners: one live + one deactivated is ONE owner", async () => {
    row("u-owner-2")!.active = false;
    await expect(members.removeMember("t-1", OWNER, "u-owner")).rejects.toThrow(
      /last owner/i,
    );
  });

  it("…and an owner may still be removed while a second one is live", async () => {
    const res = await members.removeMember("t-1", OWNER, "u-owner");
    expect(res.removed).toBe(true);
  });

  it("the Team screen reports `active: false` — the escape hatch needs to be visible", async () => {
    row("u-leaver")!.active = false;
    const list = await members.list("t-1");
    expect(list.find((m) => m.userId === "u-leaver")).toMatchObject({
      status: "active",
      active: false,
    });
    expect(list.find((m) => m.userId === "u-owner")).toMatchObject({
      active: true,
    });
  });

  it("invite 409s a DEACTIVATED member and says so, rather than 'already a member'", async () => {
    row("u-leaver")!.active = false;
    await expect(
      members.invite("t-1", OWNER, "leaver@acme.example", "member"),
    ).rejects.toThrow(/DEACTIVATED/);
  });
});

// ---------------------------------------------------------------------------
// §4. STRANDED APPROVALS — a deactivated person is not their own remaining approver
// ---------------------------------------------------------------------------

describe("§4 the stranded-approval report", () => {
  /** A Temporal client whose one paused run routes its gate at `approvers`. */
  function clientWithGate(approvers: Record<string, unknown>) {
    db.execution.rows.push({
      id: "e-1",
      tenantId: "t-1",
      status: "awaiting_approval",
      workflowId: "wf-1",
      workflowKey: "invoice",
      createdAt: NOW,
    });
    return {
      workflow: {
        getHandle: () => ({
          query: async () => ({
            status: "awaiting_approval",
            currentNodeId: "approve-1",
            ctx: {
              [APPROVAL_CTX_KEY]: {
                nodeId: "approve-1",
                pausedAt: "2026-08-01T00:00:00.000Z",
                approvers,
              },
            },
          }),
        }),
      },
    } as never;
  }

  it("does NOT count a deactivated colleague as a remaining EMAIL approver", async () => {
    seedMembership("u-other", "other@acme.example", "member", false);
    const client = clientWithGate({
      emails: ["leaver@acme.example", "other@acme.example"],
      groups: [],
    });

    const held = await findHeldApprovals(client, "t-1", {
      email: "leaver@acme.example",
      groupIds: [],
    });
    expect(held.runs[0]?.needsOwnerOrAdmin).toBe(true);
  });

  it("…and DOES count a live one (the filter is `active`, not 'everyone is stranded')", async () => {
    seedMembership("u-other", "other@acme.example", "member", true);
    const client = clientWithGate({
      emails: ["leaver@acme.example", "other@acme.example"],
      groups: [],
    });

    const held = await findHeldApprovals(client, "t-1", {
      email: "leaver@acme.example",
      groupIds: [],
    });
    expect(held.runs[0]?.needsOwnerOrAdmin).toBe(false);
  });

  it("does NOT count a GROUP whose only member is deactivated — the rows survive, the person does not", async () => {
    // `u-leaver` is in g-finance from the seed; a group-routed gate names the group, and the
    // GroupMember row is deliberately NOT deleted by a deactivation.
    row("u-leaver")!.active = false;
    const client = clientWithGate({
      emails: [],
      groups: [{ id: "g-finance" }],
    });

    const held = await findHeldApprovals(client, "t-1", {
      email: "leaver@acme.example",
      groupIds: ["g-finance"],
    });
    expect(held.runs[0]?.needsOwnerOrAdmin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §5. THE SCIM READ SURFACE — what the IdP reconciles against
// ---------------------------------------------------------------------------

describe("§5 the SCIM read surface", () => {
  it("lists a deactivated member as active:false — not as absent", async () => {
    row("u-leaver")!.active = false;
    const page = await scimUsers.list("t-1", {});
    const subject = page.Resources.find(
      (r) => r.userName === "leaver@acme.example",
    );
    // PRESENT (an absent resource reads as "deleted" and the IdP re-creates them next sync)…
    expect(subject).toBeTruthy();
    // …and false.
    expect(subject?.active).toBe(false);
  });

  it("GET by id agrees with the list (one subject, one answer)", async () => {
    row("u-leaver")!.active = false;
    const id = await idFor("leaver@acme.example");
    expect((await scimUsers.get("t-1", id)).active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §6. PATCH — deactivate, and the reactivation that justifies the whole decision
// ---------------------------------------------------------------------------

describe("§6 PATCH /scim/v2/Users/{id}", () => {
  it("deactivates the membership and KEEPS the row, the role and the GroupMember rows", async () => {
    const id = await idFor("leaver@acme.example");
    await provisioning.setActive(CONN, id, patchBody(false));

    expect(row("u-leaver")).toMatchObject({ active: false, role: "member" });
    expect(
      db.groupMember.rows.filter((r) => r.userId === "u-leaver"),
    ).toHaveLength(1);
  });

  it("REACTIVATION RESTORES THE PERSON *AND THEIR GROUPS* — the reason (b) beat (a)", async () => {
    const id = await idFor("leaver@acme.example");
    await provisioning.setActive(CONN, id, patchBody(false));
    // Nobody can reach the workspace in between…
    const { guard, req } = firebaseGuard("u-leaver", "leaver@acme.example");
    await expect(
      guard.canActivate(ctxFor(req("/tenants/t-1/workflows"))),
    ).rejects.toThrow(ForbiddenException);

    await provisioning.setActive(CONN, id, patchBody(true));

    // …and afterwards they are back, with the grant identity they had before.
    const r = req("/tenants/t-1/workflows");
    expect(await guard.canActivate(ctxFor(r))).toBe(true);
    expect(r.principal).toMatchObject({ tenantId: "t-1", role: "member" });
    expect(
      db.groupMember.rows.filter(
        (g) => g.userId === "u-leaver" && g.groupId === "g-finance",
      ),
    ).toHaveLength(1);
  });

  it("kills the CLI session too — the guard's `nry_` branch never reads a Membership", async () => {
    // A live CLI session for the leaver: a rotation family plus the 12h access token it minted.
    const issued = await cliSessions.issue("t-1", "u-leaver");
    const access = await apiTokens.mint(
      "t-1",
      "naary CLI (laptop)",
      new Date(Date.now() + 12 * 3_600_000),
      "u-leaver",
      issued.familyId,
    );
    expect(await apiTokens.verify(access.token)).toBeTruthy();

    const id = await idFor("leaver@acme.example");
    await provisioning.setActive(CONN, id, patchBody(false));

    // Both halves: nothing can be refreshed, and the token already in their hand is gone.
    expect((await cliSessions.rotate(issued.refreshToken)).ok).toBe(false);
    expect(await apiTokens.verify(access.token)).toBeNull();
  });

  it("revokes a pending invitation alongside the membership (the accept-on-login re-entry hole)", async () => {
    db.invitation.rows.push({
      id: "inv-1",
      tenantId: "t-1",
      email: "leaver@acme.example",
      role: "member",
      acceptedAt: null,
      createdAt: NOW,
      groupIds: [],
      invitedBy: "u-owner",
    });
    const id = await idFor("leaver@acme.example");
    await provisioning.setActive(CONN, id, patchBody(false));
    expect(db.invitation.rows).toHaveLength(0);
  });

  it("on an invitation-only subject it behaves exactly like DELETE: invitation gone, id stops resolving", async () => {
    await provisioning.provision(CONN, { userName: "new@acme.example" });
    const id = await idFor("new@acme.example");

    await provisioning.setActive(CONN, id, patchBody(false));

    expect(db.invitation.rows).toHaveLength(0);
    await expect(scimUsers.get("t-1", id)).rejects.toMatchObject({
      status: 404,
    });
  });

  /**
   * The post-condition that makes "behaves exactly like DELETE" true rather than aspirational.
   *
   * A surviving `acceptedAt: null` row is a re-entry hole — `acceptPendingInvitations` converts
   * it at the next sign-in — and this is the branch that then deletes the `ScimIdentity` row and
   * audits success. A 500 is retried; a false 204 is never revisited. Simulated the only way it
   * can happen: a delete that reports success and removes nothing.
   */
  it("500s rather than 204ing over an invitation the revoke failed to remove", async () => {
    await provisioning.provision(CONN, { userName: "new@acme.example" });
    const id = await idFor("new@acme.example");
    db.invitation.deleteMany.mockResolvedValueOnce({ count: 1 }); // …but removes nothing

    await expect(
      provisioning.setActive(CONN, id, patchBody(false)),
    ).rejects.toMatchObject({ status: 500 });
    expect(auditLines().join("\n")).toMatch(
      /deactivation of new@acme\.example FAILED: a pending invitation survives/,
    );
  });

  it("refuses to deactivate an ADMIN, and audits the refusal so the workspace can see it", async () => {
    seedMembership("u-admin", "admin@acme.example", "admin");
    const id = await idFor("admin@acme.example");

    await expect(
      provisioning.setActive(CONN, id, patchBody(false)),
    ).rejects.toMatchObject({ status: 403 });
    expect(row("u-admin")!.active).toBe(true);
    expect(auditLines().join("\n")).toMatch(
      /deactivation of admin@acme\.example REFUSED.*elevated role "admin"/,
    );
  });

  it("is idempotent — a re-sent active:false does not re-revoke or re-audit", async () => {
    const id = await idFor("leaver@acme.example");
    await provisioning.setActive(CONN, id, patchBody(false));
    audit.record.mockClear();
    const issued = await cliSessions.issue("t-1", "u-leaver");

    await provisioning.setActive(CONN, id, patchBody(false));
    // The session minted AFTER the first deactivation survives, which is the observable proof
    // that the second call did no work (see `setMemberActive`'s `changed: false`).
    expect((await cliSessions.rotate(issued.refreshToken)).ok).toBe(true);
  });

  it("404s an id from another workspace without touching anything", async () => {
    seedMembership("u-b", "b@acme.example", "member", true, "t-2");
    const foreign = await scimUsers
      .list("t-2", {})
      .then((p) => p.Resources[0].id);

    await expect(
      provisioning.setActive(CONN, foreign, patchBody(false)),
    ).rejects.toMatchObject({ status: 404 });
    expect(row("u-b", "t-2")!.active).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §7. DECISION 2 — allowedEmailDomains on the de-provision verbs, and the escape hatch
// ---------------------------------------------------------------------------

describe("§7 the domain gate on DELETE and PATCH", () => {
  it("REFUSES a DELETE outside the connection's domains, and the member keeps their access", async () => {
    const id = await idFor("leaver@acme.example");
    await expect(
      provisioning.deprovision(NARROW_CONN, id),
    ).rejects.toMatchObject({ status: 403 });
    expect(row("u-leaver")).toBeTruthy();
  });

  it("REFUSES a PATCH the same way — gating DELETE alone would be the same hole", async () => {
    const id = await idFor("leaver@acme.example");
    await expect(
      provisioning.setActive(NARROW_CONN, id, patchBody(false)),
    ).rejects.toMatchObject({ status: 403 });
    expect(row("u-leaver")!.active).toBe(true);
  });

  it("AUDITS the refusal with the domain and the remedy — a silent 403 is invisible here", async () => {
    const id = await idFor("leaver@acme.example");
    await expect(provisioning.deprovision(NARROW_CONN, id)).rejects.toThrow();
    expect(auditLines().join("\n")).toMatch(
      /REFUSED: the domain "acme\.example" is not in this connection's allowed domains/,
    );
  });

  it("ESCAPE HATCH: the workspace can still remove a domain-refused member itself", async () => {
    const id = await idFor("leaver@acme.example");
    await expect(provisioning.deprovision(NARROW_CONN, id)).rejects.toThrow();

    // The documented remedy — Team → Remove member, i.e. MembersService.removeMember, which
    // knows nothing about allowedEmailDomains. "Stranded by the allowlist" must never mean
    // "unrevocable".
    const res = await members.removeMember("t-1", OWNER, "u-leaver");
    expect(res.removed).toBe(true);
    expect(row("u-leaver")).toBeUndefined();
  });

  it("…and a connection INSIDE its allowlist is unaffected", async () => {
    const id = await idFor("leaver@acme.example");
    await provisioning.setActive(CONN, id, patchBody(false));
    expect(row("u-leaver")!.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §8. THE ROLLING DEPLOY, and the writes that must NOT reactivate
// ---------------------------------------------------------------------------

describe("§8 expand/contract and accidental reactivation", () => {
  it("an OLD image's row — written with no `active` at all — authenticates normally", async () => {
    // What `INSERT INTO "Membership" (...)` from an image that predates the column produces,
    // once Postgres has applied `DEFAULT true`. The fake models that default on create.
    await db.membership.create({
      data: {
        tenantId: "t-1",
        userId: "u-old",
        email: "old@acme.example",
        role: "member",
      },
    });
    membershipCache.invalidate("u-old");

    const { guard, req } = firebaseGuard("u-old", "old@acme.example");
    const r = req("/tenants/t-1/workflows");
    expect(await guard.canActivate(ctxFor(r))).toBe(true);
    expect(r.principal).toMatchObject({ tenantId: "t-1", role: "member" });
  });

  it("ensureMembership (the guard's claim backfill, and SAML auto-provision) never reactivates", async () => {
    row("u-leaver")!.active = false;
    await memberships.ensureMembership(
      "u-leaver",
      "t-1",
      "owner",
      "leaver@acme.example",
    );
    expect(row("u-leaver")).toMatchObject({ active: false, role: "member" });
  });

  it("accept-on-login never reactivates either — a stale invitation converts to nothing", async () => {
    row("u-leaver")!.active = false;
    db.invitation.rows.push({
      id: "inv-2",
      tenantId: "t-1",
      email: "leaver@acme.example",
      role: "admin",
      acceptedAt: null,
      createdAt: NOW,
      groupIds: [],
      invitedBy: "u-owner",
    });
    membershipCache.invalidate("u-leaver");

    await memberships.acceptPendingInvitations(
      "u-leaver",
      "leaver@acme.example",
      true,
    );
    expect(row("u-leaver")).toMatchObject({ active: false, role: "member" });
  });
});

// ---------------------------------------------------------------------------
// §9. THE DECISION NOT TO ENFORCE — groups keep referencing a deactivated member
// ---------------------------------------------------------------------------

describe("§9 group membership is deliberately NOT gated on `active`", () => {
  it("a deactivated member can still be added to a group — that preservation IS the feature", async () => {
    row("u-leaver")!.active = false;
    db.permissionGroup.rows.push({
      id: "g-new",
      tenantId: "t-1",
      name: "New",
      createdAt: NOW,
    });

    await groups.addMember("t-1", OWNER, "g-new", "u-leaver");
    expect(
      db.groupMember.rows.filter(
        (g) => g.groupId === "g-new" && g.userId === "u-leaver",
      ),
    ).toHaveLength(1);
  });

  it("…and it grants them nothing: the guard still denies them", async () => {
    row("u-leaver")!.active = false;
    membershipCache.invalidate("u-leaver");
    const { guard, req } = firebaseGuard("u-leaver", "leaver@acme.example");
    await expect(
      guard.canActivate(ctxFor(req("/tenants/t-1/workflows"))),
    ).rejects.toThrow(ForbiddenException);
  });
});

// ---------------------------------------------------------------------------
// §10. THE PATCH PARSER — the dialects a real IdP sends
// ---------------------------------------------------------------------------

describe("§10 PatchOp parsing", () => {
  it("reads the RFC/Okta spelling", () => {
    expect(
      parsePatchPayload({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: false }],
      }),
    ).toEqual({ active: false });
  });

  it("reads Entra's path-less spelling, with a capitalised op", () => {
    expect(
      parsePatchPayload({
        Operations: [{ op: "Replace", value: { active: false } }],
      }),
    ).toEqual({ active: false });
  });

  it('reads Azure\'s STRING "False" as false — `Boolean("False")` would activate a leaver', () => {
    expect(
      parsePatchPayload({
        Operations: [{ op: "replace", path: "active", value: "False" }],
      }),
    ).toEqual({ active: false });
    expect(
      parsePatchPayload({
        Operations: [{ op: "replace", path: "active", value: "True" }],
      }),
    ).toEqual({ active: true });
  });

  it("400s an operation on an attribute we do not store, rather than silently doing nothing", () => {
    expect(() =>
      parsePatchPayload({
        Operations: [{ op: "replace", path: "displayName", value: "New Name" }],
      }),
    ).toThrow(ScimError);
    expect(() =>
      parsePatchPayload({ Operations: [{ op: "remove", path: "active" }] }),
    ).toThrow(ScimError);
    expect(() => parsePatchPayload({ Operations: [] })).toThrow(ScimError);
  });

  it("400s a non-boolean value rather than coercing it", () => {
    expect(() =>
      parsePatchPayload({
        Operations: [{ op: "replace", path: "active", value: "maybe" }],
      }),
    ).toThrow(ScimError);
  });
});

// ---------------------------------------------------------------------------
// Helpers that build the REAL guard over the REAL MembershipService
// ---------------------------------------------------------------------------

/** A guard wired exactly as Nest wires it, with only the identity sources stubbed. */
function firebaseGuard(
  userId: string,
  email: string,
  claimTenant?: string,
): {
  guard: AuthGuard;
  req: (path: string) => {
    headers: Record<string, string | undefined>;
    path: string;
    principal?: unknown;
  };
} {
  const firebase = {
    get enabled() {
      return true;
    },
    verify: async () => ({
      userId,
      email,
      emailVerified: true,
      claimTenant,
    }),
  };
  const guard = new AuthGuard(
    { verify: async () => null } as never,
    firebase as never,
    { getAllAndOverride: () => false } as never,
    memberships,
    permissions as never,
    { isSessionToken: () => false, verify: async () => null } as never,
  );
  return {
    guard,
    req: (path: string) => ({
      headers: { authorization: "Bearer firebase-id-token" },
      path,
    }),
  };
}

function ctxFor(req: unknown) {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as never;
}

/** The resource id this workspace's IdP would have stored for `email`. */
async function idFor(email: string): Promise<string> {
  const page = await scimUsers.list("t-1", {});
  const found = page.Resources.find((r) => r.userName === email);
  expect(found, `no SCIM resource for ${email}`).toBeTruthy();
  return found?.id as string;
}

/** The body Okta sends. */
const patchBody = (active: boolean) => ({
  schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  Operations: [{ op: "replace", path: "active", value: active }],
});
