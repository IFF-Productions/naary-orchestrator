import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1117 — a CLI refresh family must not outlive the membership it was minted for.
 *
 * `members.service.ts` says "revocation is immediate" and said it while `removeMember` never
 * touched `CliRefreshToken`. A `CliRefreshToken` row is keyed to a `userId` and carries a 90-day
 * absolute cap, so a removed member kept rotating for up to a quarter, collecting a fresh 12h
 * `nry_` access token each time — one the `AuthGuard` stamps `role: "owner"`.
 *
 * THE ASSERTION IS THAT THE TOKEN IS REJECTED, not that a method was called. Every test here
 * drives the REAL `MembersService` and the REAL `CliRefreshTokenService` over one stateful table
 * and finishes at `rotate(plaintext)` — the same call `POST /auth/cli/refresh` makes. A
 * `toHaveBeenCalledWith("revokeFamily")` would go green against a revoke that revoked the wrong
 * family, the wrong tenant's, or wrote a column `rotate` does not read; this cannot.
 *
 * Each test also rotates ONCE BEFORE the offboarding and asserts that succeeded, so a test that
 * went green because the token was never valid in the first place is not possible.
 *
 * The cross-tenant and cross-user cases are the ones with real teeth: `revokeFamily` takes a bare
 * `familyId`, so the tenant scoping lives entirely in the read that resolves which families to
 * kill. A consultant removed from one workspace must keep their CLI session in the others.
 */

type Row = Record<string, unknown>;

/** Every key in `where` must match. Handles the four shapes these two services use: a literal
 *  (including `null`, which is how "still live" is spelled), a `Date` (by instant), `{ equals,
 *  mode }`, and a nested RELATION filter (`group: { tenantId }` — `removeMember`'s group delete).
 *  An unknown shape fails closed rather than matching everything. */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    const got = row[k];
    if (cond instanceof Date)
      return got instanceof Date && got.getTime() === cond.getTime();
    if (cond !== null && typeof cond === "object") {
      const c = cond as { equals?: unknown; mode?: string };
      if ("equals" in c) {
        if (
          c.mode === "insensitive" &&
          typeof got === "string" &&
          typeof c.equals === "string"
        ) {
          return got.toLowerCase() === c.equals.toLowerCase();
        }
        return got === c.equals;
      }
      if (got && typeof got === "object")
        return matches(got as Row, cond as Row);
      return false;
    }
    return got === cond;
  });
}

/** Minimal stateful table. `updateMany` MUTATES the stored rows — that is what makes the later
 *  `rotate` observe `revokedAt` instead of a fake's bookkeeping. */
function table(rows: Row[], defaults: Row = {}) {
  let seq = 0;
  return {
    rows,
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
      // Real Prisma resolves a compound unique from its `a_b` key; everything else is ignored.
      const sel = (where.userId_tenantId ?? where) as Row;
      return rows.find((r) => matches(r, sel)) ?? null;
    }),
    findFirst: vi.fn(
      async ({ where }: { where?: Row } = {}) =>
        rows.find((r) => matches(r, where)) ?? null,
    ),
    findMany: vi.fn(async ({ where }: { where?: Row } = {}) =>
      rows.filter((r) => matches(r, where)),
    ),
    count: vi.fn(
      async ({ where }: { where?: Row } = {}) =>
        rows.filter((r) => matches(r, where)).length,
    ),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = { id: `row-${++seq}`, ...defaults, ...data };
      rows.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const sel = (where.userId_tenantId ?? where) as Row;
      const found = rows.find((r) => matches(r, sel));
      if (found) Object.assign(found, data);
      return found ?? null;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Row }) => {
      const keep = rows.filter((r) => !matches(r, where));
      const count = rows.length - keep.length;
      rows.length = 0;
      rows.push(...keep);
      return { count };
    }),
  };
}

const db = {
  membership: table([]),
  groupMember: table([]),
  invitation: table([]),
  tenantSettings: table([]),
  cliRefreshToken: table([], {
    createdAt: new Date(),
    lastUsedAt: null,
    rotatedAt: null,
    revokedAt: null,
  }),
  $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
};

vi.mock("@naary/db", () => ({ getPrisma: () => db }));

import type { AuditService } from "../src/audit/audit.service";
import { CliRefreshTokenService } from "../src/auth/cli-refresh-token.service";
import type { Principal } from "../src/auth/tenant.decorator";
import type { ExecutionsService } from "../src/executions/executions.service";
import type { MailerService } from "../src/mail/mailer.service";
import type { MembershipService } from "../src/membership/membership.service";
import { MembersService } from "../src/members/members.service";
import type { PermissionsService } from "../src/permissions/permissions.service";

const heldApprovals = vi.fn().mockResolvedValue({
  total: 0,
  needsOwnerOrAdmin: 0,
  partial: false,
  runs: [],
});
const auditRecord = vi.fn().mockResolvedValue(undefined);
const invalidate = vi.fn();
const invalidateTenant = vi.fn();

/** REAL, not a double — the whole point is that the revoke reaches the rotation state machine. */
const cliSessions = new CliRefreshTokenService();

const svc = new MembersService(
  { invalidate } as unknown as MembershipService,
  { sendInvitation: vi.fn() } as unknown as MailerService,
  { invalidateTenant } as unknown as PermissionsService,
  { heldApprovals } as unknown as ExecutionsService,
  { record: auditRecord } as unknown as AuditService,
  cliSessions,
);

const asOwner: Principal = { tenantId: "t-1", userId: "u-own", role: "owner" };

function seedMember(tenantId: string, userId: string, role = "admin"): void {
  db.membership.rows.push({
    id: `m-${tenantId}-${userId}`,
    tenantId,
    userId,
    role,
    email: `${userId}@example.com`,
    createdAt: new Date(),
    lastActiveAt: null,
  });
}

/** Sign a user into the CLI in a workspace and hand back their CURRENT refresh token. */
async function cliLogin(tenantId: string, userId: string): Promise<string> {
  const issued = await cliSessions.issue(tenantId, userId);
  return issued.refreshToken;
}

/** Rotate, asserting it worked — the "this token was genuinely live" precondition. */
async function rotateOk(token: string): Promise<string> {
  const res = await cliSessions.rotate(token);
  if (!res.ok) throw new Error(`expected a live token, got ${res.reason}`);
  return res.refreshToken;
}

const liveTokens = () =>
  db.cliRefreshToken.rows.filter((r) => r.revokedAt === null);

beforeEach(() => {
  for (const t of [
    db.membership,
    db.groupMember,
    db.invitation,
    db.tenantSettings,
    db.cliRefreshToken,
  ]) {
    t.rows.length = 0;
    for (const fn of Object.values(t)) {
      if (typeof fn === "function" && "mockClear" in fn) fn.mockClear();
    }
  }
  auditRecord.mockClear();
  invalidate.mockClear();
  invalidateTenant.mockClear();
});

describe("member removal kills the user's CLI refresh families (#1117)", () => {
  it("REJECTS the removed user's refresh token on the very next rotate", async () => {
    seedMember("t-1", "u-cli");
    const first = await cliLogin("t-1", "u-cli");
    // Live before the removal — otherwise the assertion below proves nothing.
    const current = await rotateOk(first);

    const res = await svc.removeMember("t-1", asOwner, "u-cli");
    expect(res.removed).toBe(true);

    // The headline. This is exactly what POST /auth/cli/refresh does with the token the CLI
    // holds; slice 3 turns a non-ok result into a 401 with no successor minted.
    const after = await cliSessions.rotate(current);
    expect(after).toEqual({ ok: false, reason: "revoked" });
    // …and no live row is left for anything else in the family to rotate from.
    expect(liveTokens()).toHaveLength(0);
  });

  it("kills the WHOLE family, including a token still in flight from an earlier rotation", async () => {
    seedMember("t-1", "u-cli");
    // Two CLI processes, both holding a successor of the same family (the grace-window case).
    const first = await cliLogin("t-1", "u-cli");
    const a = await rotateOk(first);
    const b = await rotateOk(first); // sibling minted inside the 60s grace window

    await svc.removeMember("t-1", asOwner, "u-cli");

    expect((await cliSessions.rotate(a)).ok).toBe(false);
    expect((await cliSessions.rotate(b)).ok).toBe(false);
  });

  it("does NOT touch the same user's session in another workspace", async () => {
    // One consultant, two workspaces, one CLI session in each.
    seedMember("t-1", "u-cli");
    seedMember("t-2", "u-cli");
    const inT1 = await cliLogin("t-1", "u-cli");
    const inT2 = await cliLogin("t-2", "u-cli");

    await svc.removeMember("t-1", asOwner, "u-cli");

    expect((await cliSessions.rotate(inT1)).ok).toBe(false);
    // Their access to t-2 is untouched, so their CLI session there must be too.
    expect((await cliSessions.rotate(inT2)).ok).toBe(true);
  });

  it("does NOT touch another user's session in the same workspace", async () => {
    seedMember("t-1", "u-cli");
    seedMember("t-1", "u-other");
    const removed = await cliLogin("t-1", "u-cli");
    const kept = await cliLogin("t-1", "u-other");

    await svc.removeMember("t-1", asOwner, "u-cli");

    expect((await cliSessions.rotate(removed)).ok).toBe(false);
    expect((await cliSessions.rotate(kept)).ok).toBe(true);
  });

  it("is a no-op for a member who never used the CLI, and never blocks the removal", async () => {
    seedMember("t-1", "u-plain");
    const res = await svc.removeMember("t-1", asOwner, "u-plain");
    expect(res.removed).toBe(true);
    expect(db.cliRefreshToken.updateMany).not.toHaveBeenCalled();
  });

  it("SCIM/unknown uid: nothing is revoked when nothing was removed", async () => {
    // A stale uid from a directory sync must not reach through and kill a live session — the
    // removal itself is a documented no-op, so the revocation must be one too.
    seedMember("t-1", "u-cli");
    const live = await cliLogin("t-1", "u-cli");

    const res = await svc.removeMember("t-1", asOwner, "u-nobody");

    expect(res.removed).toBe(false);
    expect((await cliSessions.rotate(live)).ok).toBe(true);
  });
});

describe("demotion kills the CLI session too (#1117)", () => {
  /**
   * Not belt-and-braces: a CLI access token is an `nry_` ApiToken, and the AuthGuard's `nry_`
   * branch stamps `role: "owner"` from the TOKEN row without reading a Membership — so a demoted
   * user's CLI keeps owner authority for as long as it can keep refreshing.
   */
  it("REJECTS the token after an owner is demoted to member", async () => {
    seedMember("t-1", "u-cli", "owner");
    seedMember("t-1", "u-own", "owner"); // so the last-owner guard doesn't 409
    const current = await rotateOk(await cliLogin("t-1", "u-cli"));

    await svc.changeRole("t-1", asOwner, "u-cli", "member");

    expect(await cliSessions.rotate(current)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("leaves the session alone on owner→admin, which loses no CLI authority", async () => {
    seedMember("t-1", "u-cli", "owner");
    seedMember("t-1", "u-own", "owner");
    const current = await rotateOk(await cliLogin("t-1", "u-cli"));

    await svc.changeRole("t-1", asOwner, "u-cli", "admin");

    // An admin may approve a CLI login and that token already stamps owner — signing them out
    // would cost a re-auth and buy nothing.
    expect((await cliSessions.rotate(current)).ok).toBe(true);
  });

  it("leaves the session alone when the role did not actually change", async () => {
    // A no-op PATCH — an admin re-saving an unchanged role — is not a demotion, and must not
    // sign a plain member out of a CLI session they legitimately hold (a workspace with grants
    // enforced stamps restricted tokens `member`, and a family can outlive a failed revoke).
    seedMember("t-1", "u-cli", "member");
    const current = await rotateOk(await cliLogin("t-1", "u-cli"));

    await svc.changeRole("t-1", asOwner, "u-cli", "member");

    expect((await cliSessions.rotate(current)).ok).toBe(true);
  });

  it("leaves the session alone on a PROMOTION to owner", async () => {
    seedMember("t-1", "u-cli", "admin");
    const current = await rotateOk(await cliLogin("t-1", "u-cli"));

    await svc.changeRole("t-1", asOwner, "u-cli", "owner");

    expect((await cliSessions.rotate(current)).ok).toBe(true);
  });
});

describe("a failed revoke never breaks the removal (#1117)", () => {
  /**
   * The removal has ALREADY COMMITTED by the time the revoke runs, so throwing here would report
   * a failure for something that definitely happened — and on the SCIM path that means an IdP
   * told a terminated user still has access when they do not. It is logged and AUDITED instead,
   * because "the family is still live" has to be findable later.
   */
  it("still removes the member, reports removed:true, and audits the failure", async () => {
    seedMember("t-1", "u-cli");
    await cliLogin("t-1", "u-cli");
    db.cliRefreshToken.findMany.mockRejectedValueOnce(new Error("db is down"));

    const res = await svc.removeMember("t-1", asOwner, "u-cli");

    expect(res.removed).toBe(true);
    // The membership really is gone — the security-critical half committed.
    expect(db.membership.rows).toHaveLength(0);
    // …and the shortfall is on the record, on the surface a directory sync leaves behind.
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t-1",
        action: expect.stringContaining("revoking their CLI sessions failed"),
      }),
    );
  });

  it("still applies the role change when the revoke fails", async () => {
    seedMember("t-1", "u-cli", "owner");
    seedMember("t-1", "u-own", "owner");
    await cliLogin("t-1", "u-cli");
    db.cliRefreshToken.findMany.mockRejectedValueOnce(new Error("db is down"));

    const view = await svc.changeRole("t-1", asOwner, "u-cli", "member");

    expect(view.role).toBe("member");
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ method: "PATCH" }),
    );
  });
});
