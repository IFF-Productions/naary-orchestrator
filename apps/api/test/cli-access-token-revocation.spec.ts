import "reflect-metadata";
import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `ApiToken.userId` — the owner column that closes the ACCESS-token window #1118 documented and
 * deliberately left open (the "TWO RESIDUALS" block on `CliAuthController.refresh`).
 *
 * #1118 kills a removed member's refresh FAMILIES, so their CLI can mint nothing new. The `nry_`
 * token already sitting in their `~/.naary/config.json` still authenticated for up to 12 more
 * hours, because `ApiToken` had no way to say whose it was: the row was unattributable, and a
 * delete scoped by the `naary CLI` label would have signed out every other CLI session in the
 * workspace.
 *
 * THE ASSERTION IS THAT THE TOKEN IS REJECTED, not that a delete was called. Every test drives the
 * REAL `MembersService`, the REAL `ApiTokenService`, the REAL `CliRefreshTokenService` and the REAL
 * `CliAuthController` over one stateful table, and ends at `AuthGuard.canActivate` — the same call
 * every REST request makes — asserting a 401. A `toHaveBeenCalledWith` would go green against a
 * delete that removed the wrong tenant's row, the wrong user's, or wrote a column `verify()` does
 * not read.
 *
 * THE NEGATIVES ARE WHERE THE RISK IS, and one of them is doing nearly all the work:
 *
 *  - a Settings/CI token (`userId: null`, label `"ci"`) surviving proves little — a delete scoped
 *    by LABEL ALONE would spare it too, purely because of its label. It is here because it is the
 *    worst and quietest failure mode (a workspace's automation silently signed out by a routine
 *    offboarding), not because it discriminates.
 *  - an UNOWNED token whose label DOES start with the CLI stem is the discriminating case. That is
 *    not a contrivance: it is every CLI token minted before this migration, and every one an old
 *    image mints mid-rollout. It can only survive if the delete is scoped by `userId`.
 *
 * Both directions of the mutation check are recorded in the PR: deleting the
 * `revokeUserCliTokens` call turns the positives red; dropping `userId` from its `where` turns the
 * unowned-CLI-labelled and other-user negatives red.
 */

type Row = Record<string, unknown>;

/** Prisma-ish predicate covering the four shapes these services use: a literal (including `null`,
 *  which is how "unowned" and "still live" are both spelled), a `Date` (by instant), the two
 *  operators (`lt` for expiry, `startsWith` for the CLI label stem), and a nested RELATION filter
 *  (`group: { tenantId }` — `removeMember`'s group delete). An unrecognised shape fails CLOSED
 *  rather than matching everything, so a query the fake does not understand cannot look like a
 *  successful revocation. */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    const got = row[k];
    if (cond === undefined) return true;
    if (cond instanceof Date)
      return got instanceof Date && got.getTime() === cond.getTime();
    if (cond !== null && typeof cond === "object") {
      const c = cond as Record<string, unknown>;
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
      if ("startsWith" in c)
        return (
          typeof got === "string" &&
          typeof c.startsWith === "string" &&
          got.startsWith(c.startsWith)
        );
      if ("lt" in c)
        return got instanceof Date && c.lt instanceof Date && got < c.lt;
      if (got && typeof got === "object") return matches(got as Row, c);
      return false;
    }
    return got === cond;
  });
}

/** Minimal stateful table. `deleteMany` really removes rows and `updateMany` really mutates them —
 *  that is what lets a later `verify()` / `rotate()` observe the revocation instead of a fake's
 *  bookkeeping. `defaults` reproduce the columns Postgres would default to NULL; `userId: null` in
 *  particular is what an unowned token looks like, and a fake that left it ABSENT would make
 *  `userId: "u-x"` fail to match for the wrong reason. */
function table(rows: Row[], defaults: Row = {}) {
  let seq = 0;
  return {
    rows,
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
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
  cliAuthRequest: table([], {
    approvedAt: null,
    deniedAt: null,
    consumedAt: null,
    tenantId: null,
    userId: null,
  }),
  apiToken: table([], {
    createdAt: new Date(),
    lastUsedAt: null,
    expiresAt: null,
    environmentId: null,
    userId: null,
    familyId: null,
  }),
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
import {
  ApiTokenService,
  CLI_TOKEN_LABEL_STEM,
} from "../src/auth/api-token.service";
import { AuthGuard } from "../src/auth/auth.guard";
import { CliAuthRequestService } from "../src/auth/cli-auth-request.service";
import { CliAuthController } from "../src/auth/cli-auth.controller";
import { CliRefreshTokenService } from "../src/auth/cli-refresh-token.service";
import type { FirebaseVerifier } from "../src/auth/firebase-verifier";
import type { Principal } from "../src/auth/tenant.decorator";
import type { ExecutionsService } from "../src/executions/executions.service";
import type { MailerService } from "../src/mail/mailer.service";
import type { MembershipService } from "../src/membership/membership.service";
import { MembersService } from "../src/members/members.service";
import type { PermissionsService } from "../src/permissions/permissions.service";
import type { SsoSessionService } from "../src/sso/sso-session.service";

// Everything below the fake Prisma is real.
const apiTokens = new ApiTokenService();
const cliSessions = new CliRefreshTokenService();
const requests = new CliAuthRequestService();
const cliAuth = new CliAuthController(requests, apiTokens, cliSessions);

const heldApprovals = vi.fn().mockResolvedValue({
  total: 0,
  needsOwnerOrAdmin: 0,
  partial: false,
  runs: [],
});
const auditRecord = vi.fn().mockResolvedValue(undefined);

const members = new MembersService(
  { invalidate: vi.fn() } as unknown as MembershipService,
  { sendInvitation: vi.fn() } as unknown as MailerService,
  { invalidateTenant: vi.fn() } as unknown as PermissionsService,
  { heldApprovals } as unknown as ExecutionsService,
  { record: auditRecord } as unknown as AuditService,
  cliSessions,
  apiTokens,
);

const asOwner: Principal = { tenantId: "t-1", userId: "u-own", role: "owner" };

// ---------------------------------------------------------------------------
// The real AuthGuard — the end every assertion below lands at.
// ---------------------------------------------------------------------------
interface FakeReq {
  headers: Record<string, string | undefined>;
  path?: string;
  principal?: Principal;
}

function ctx(req: FakeReq): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function makeGuard(): AuthGuard {
  return new AuthGuard(
    apiTokens,
    {
      get enabled() {
        return false;
      },
      verify: vi.fn(),
    } as unknown as FirebaseVerifier,
    { getAllAndOverride: vi.fn(() => false) } as unknown as Reflector,
    {
      listForUser: vi.fn(async () => []),
      ensureMembership: vi.fn(),
      acceptPendingInvitations: vi.fn(),
      touchLastActive: vi.fn(),
    } as unknown as MembershipService,
    {
      isTenantEnforced: vi.fn(async () => false),
    } as unknown as PermissionsService,
    {
      isSessionToken: (t: string) => t.startsWith("nrys_"),
      verify: vi.fn(),
    } as unknown as SsoSessionService,
  );
}

/** Present `token` on a real request. Resolves to the principal the guard attached, or null if it
 *  threw — i.e. a 401. This is the ONLY way this file asks "does this token still work?". */
async function authenticate(token: string): Promise<Principal | null> {
  const req: FakeReq = {
    headers: { authorization: `Bearer ${token}` },
    path: "/workflows",
  };
  try {
    await makeGuard().canActivate(ctx(req));
    return req.principal ?? null;
  } catch {
    return null;
  }
}

const isLive = async (token: string) => (await authenticate(token)) !== null;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function seedMember(tenantId: string, userId: string, role = "admin"): void {
  db.membership.rows.push({
    id: `m-${tenantId}-${userId}`,
    tenantId,
    userId,
    role,
    email: `${userId}@example.com`,
    createdAt: new Date(),
    lastActiveAt: null,
    // #1115's column, spelled the way Postgres would (NOT NULL DEFAULT true) — a fixture that
    // omitted it would read as DEACTIVATED to the live-owner count in `assertNotLastOwner`.
    active: true,
  });
}

/**
 * A full CLI login through the REAL handshake — start → approve → exchange — returning the tokens
 * the CLI ends up holding. Driving the controller (rather than calling `mint` with a uid by hand)
 * is what makes this a test of the SHIPPED path: if `exchange` ever stopped passing the approver's
 * uid, every revocation assertion below would fail.
 */
async function cliLogin(
  tenantId: string,
  userId: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const started = await cliAuth.start({ hostname: "laptop" });
  await cliAuth.approve({ tenantId, userId, role: "owner" } as Principal, {
    userCode: started.userCode,
  });
  const res = await cliAuth.exchange({ deviceCode: started.deviceCode });
  if (res.status !== "authorized") throw new Error(`exchange: ${res.status}`);
  return {
    accessToken: res.accessToken as string,
    refreshToken: res.refreshToken as string,
  };
}

/** The row the handshake wrote, found by the plaintext's presence in the table. */
const tokenRows = () => db.apiToken.rows;

beforeEach(() => {
  for (const t of [
    db.membership,
    db.groupMember,
    db.invitation,
    db.tenantSettings,
    db.cliAuthRequest,
    db.apiToken,
    db.cliRefreshToken,
  ]) {
    t.rows.length = 0;
    for (const fn of Object.values(t)) {
      if (typeof fn === "function" && "mockClear" in fn) fn.mockClear();
    }
  }
  auditRecord.mockClear();
  heldApprovals.mockClear();
});

// ---------------------------------------------------------------------------
// 1. Who gets an owner, and who deliberately does not.
// ---------------------------------------------------------------------------
describe("ApiToken.userId is stamped by the CLI handshake and by nothing else", () => {
  it("the exchange stamps the uid of the human who approved the login", async () => {
    await cliLogin("t-1", "u-cli");
    expect(tokenRows()).toHaveLength(1);
    expect(tokenRows()[0]).toMatchObject({
      tenantId: "t-1",
      userId: "u-cli",
      label: expect.stringContaining(CLI_TOKEN_LABEL_STEM),
    });
  });

  it("a REFRESH stamps it too — the first rotation must not launder an owned token into an unowned one", async () => {
    const session = await cliLogin("t-1", "u-cli");
    const res = await cliAuth.refresh({ refreshToken: session.refreshToken });
    expect(res.status).toBe("authorized");
    // Two rows now: the exchange's and the refresh's. BOTH must be attributable, otherwise a
    // session that has been running for a day is unrevocable again.
    expect(tokenRows()).toHaveLength(2);
    for (const row of tokenRows()) expect(row.userId).toBe("u-cli");
  });

  it("a Settings/CI token stays UNOWNED — it is a workspace capability, not a person's session", async () => {
    // This is the `TokensController.create` call shape: no expiry, no owner, no session.
    await apiTokens.mint("t-1", "ci");
    expect(tokenRows()[0].userId).toBeNull();
    expect(tokenRows()[0].familyId).toBeNull();
  });

  it("stamps the SESSION too, at the exchange and through every rotation", async () => {
    // `familyId` is the second revocation key (#1078 §5 follow-up), and it needs exactly the
    // discipline `userId` needed: carried through refresh, or the first rotation launders a
    // revocable token into an unrevocable one — silently, and only for sessions old enough that
    // nobody re-tests them.
    const session = await cliLogin("t-1", "u-cli");
    const family = db.cliRefreshToken.rows[0].familyId as string;
    expect(family).toBeTruthy();
    expect(tokenRows()[0].familyId).toBe(family);

    await cliAuth.refresh({ refreshToken: session.refreshToken });
    expect(tokenRows()).toHaveLength(2);
    // Same family on both rows: rotation stays inside one session, so the token a day-old CLI
    // holds is as revocable as the one its login minted.
    for (const row of tokenRows()) expect(row.familyId).toBe(family);
  });

  it("does NOT reach the principal — an owned token still cannot approve a CLI login", async () => {
    // The load-bearing reason `verify()` keeps its return shape: a principal carrying a `userId`
    // satisfies `assertMayApprove`, so a CLI access token could approve a login that mints
    // ANOTHER CLI token — self-replication off a leaked bearer. The column revokes; it never
    // authorizes.
    const session = await cliLogin("t-1", "u-cli");
    const principal = await authenticate(session.accessToken);
    expect(principal).toMatchObject({ tenantId: "t-1", role: "owner" });
    expect(principal?.userId).toBeUndefined();
    // And neither does the SESSION handle. The guard destructures `verify()` field by field, so
    // this holds today whatever that method returns — which is exactly why the rule is on the
    // return TYPE: `familyId` on a principal is a handle to `DELETE /cli-sessions/:familyId`, and
    // a bearer that can name its own session is a step towards a token acting on sessions.
    expect((principal as Record<string, unknown> | null)?.familyId).toBe(
      undefined,
    );

    const started = await cliAuth.start({ hostname: "attacker" });
    await expect(
      cliAuth.approve(principal as Principal, { userCode: started.userCode }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ---------------------------------------------------------------------------
// 2. The headline: removal kills the token in the user's hand.
// ---------------------------------------------------------------------------
describe("member removal rejects the removed user's live ACCESS token (#1118's residual)", () => {
  it("401s at the guard on the very next request", async () => {
    seedMember("t-1", "u-cli");
    const session = await cliLogin("t-1", "u-cli");
    // Live BEFORE the removal — otherwise the assertion below proves nothing.
    expect(await isLive(session.accessToken)).toBe(true);

    const res = await members.removeMember("t-1", asOwner, "u-cli");
    expect(res.removed).toBe(true);

    expect(await authenticate(session.accessToken)).toBeNull();
  });

  it("kills the token a REFRESH minted, not just the exchange's", async () => {
    // The realistic case: a session that has been running for a day or more, so the token in
    // hand came from `/auth/cli/refresh`.
    seedMember("t-1", "u-cli");
    const session = await cliLogin("t-1", "u-cli");
    const rotated = await cliAuth.refresh({
      refreshToken: session.refreshToken,
    });
    const current = (rotated as { accessToken: string }).accessToken;
    expect(await isLive(current)).toBe(true);

    await members.removeMember("t-1", asOwner, "u-cli");

    expect(await isLive(current)).toBe(false);
  });

  it("kills EVERY device the removed member had, not just one session", async () => {
    // The complement of the per-session revoke: offboarding is `userId`-scoped precisely because
    // it must be WIDER than a session. A leaver with a laptop and a desktop loses both.
    seedMember("t-1", "u-cli");
    const laptop = await cliLogin("t-1", "u-cli");
    const desktop = await cliLogin("t-1", "u-cli");
    expect(db.cliRefreshToken.rows[0].familyId).not.toBe(
      db.cliRefreshToken.rows[1].familyId,
    );

    await members.removeMember("t-1", asOwner, "u-cli");

    expect(await isLive(laptop.accessToken)).toBe(false);
    expect(await isLive(desktop.accessToken)).toBe(false);
  });

  it("does not audit on the happy path — a swallowed TypeError must not read as success", async () => {
    // `revokeCliSessions` catches EVERYTHING and returns normally, so a broken call (a missing
    // delegate, a renamed method) would be invisible. The audit row is the only outward sign,
    // and its absence here is what says the revocation really ran.
    seedMember("t-1", "u-cli");
    await cliLogin("t-1", "u-cli");
    await members.removeMember("t-1", asOwner, "u-cli");
    expect(auditRecord).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. The negatives — revocation must not widen.
// ---------------------------------------------------------------------------
describe("revocation does not widen beyond the removed user's own CLI tokens", () => {
  it("leaves an UNOWNED but CLI-LABELLED token alive — the discriminating case", async () => {
    // What every token minted before this column existed looks like, and what an OLD image mints
    // during a rolling deploy. Same workspace, same label stem, no owner. Only a `userId`-scoped
    // delete spares it; a label-scoped one takes it.
    seedMember("t-1", "u-cli");
    const session = await cliLogin("t-1", "u-cli");
    const legacy = await apiTokens.mint("t-1", `${CLI_TOKEN_LABEL_STEM} — old`);
    expect(await isLive(legacy.token)).toBe(true);

    await members.removeMember("t-1", asOwner, "u-cli");

    expect(await isLive(session.accessToken)).toBe(false);
    expect(await isLive(legacy.token)).toBe(true);
  });

  it("leaves a sibling SETTINGS token in the same workspace alive", async () => {
    // The worst and quietest failure mode: a routine offboarding silently breaking the
    // workspace's CI. A Settings token has always survived member removal by design — it belongs
    // to the workspace, not the person — and adding an owner column must not change that.
    seedMember("t-1", "u-cli");
    const session = await cliLogin("t-1", "u-cli");
    const ci = await apiTokens.mint("t-1", "ci");
    const mcp = await apiTokens.mint("t-1", "mcp server");
    expect(await isLive(ci.token)).toBe(true);

    await members.removeMember("t-1", asOwner, "u-cli");

    expect(await isLive(session.accessToken)).toBe(false);
    expect(await isLive(ci.token)).toBe(true);
    expect(await isLive(mcp.token)).toBe(true);
  });

  it("leaves ANOTHER user's CLI token in the same workspace alive", async () => {
    seedMember("t-1", "u-cli");
    seedMember("t-1", "u-other");
    const removed = await cliLogin("t-1", "u-cli");
    const kept = await cliLogin("t-1", "u-other");

    await members.removeMember("t-1", asOwner, "u-cli");

    expect(await isLive(removed.accessToken)).toBe(false);
    expect(await isLive(kept.accessToken)).toBe(true);
  });

  it("leaves the SAME user's CLI token in another workspace alive", async () => {
    // A consultant removed from one workspace keeps their session in the others — the tenant
    // scoping, which `revokeFamily`'s bare familyId makes easy to lose.
    seedMember("t-1", "u-cli");
    seedMember("t-2", "u-cli");
    const inT1 = await cliLogin("t-1", "u-cli");
    const inT2 = await cliLogin("t-2", "u-cli");

    await members.removeMember("t-1", asOwner, "u-cli");

    expect(await isLive(inT1.accessToken)).toBe(false);
    expect(await isLive(inT2.accessToken)).toBe(true);
  });

  it("revokes nothing when a stale uid removed nothing (the SCIM no-op)", async () => {
    seedMember("t-1", "u-cli");
    const session = await cliLogin("t-1", "u-cli");

    const res = await members.removeMember("t-1", asOwner, "u-nobody");

    expect(res.removed).toBe(false);
    expect(await isLive(session.accessToken)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Demotion — the same revocation, the same predicate as #1118.
// ---------------------------------------------------------------------------
describe("demotion rejects the demoted user's live ACCESS token", () => {
  it("401s after an owner is demoted to member", async () => {
    seedMember("t-1", "u-cli", "owner");
    seedMember("t-1", "u-own", "owner"); // so the last-owner guard doesn't 409
    const session = await cliLogin("t-1", "u-cli");
    expect(await isLive(session.accessToken)).toBe(true);

    await members.changeRole("t-1", asOwner, "u-cli", "member");

    // Load-bearing, not belt-and-braces: the guard's `nry_` branch stamps `role: "owner"` from
    // the TOKEN row and reads no Membership, so a demoted user's CLI keeps owner authority for
    // as long as the token lives.
    expect(await isLive(session.accessToken)).toBe(false);
  });

  it("leaves the token alone on owner→admin and on a no-op re-save", async () => {
    seedMember("t-1", "u-cli", "owner");
    seedMember("t-1", "u-own", "owner");
    const session = await cliLogin("t-1", "u-cli");

    await members.changeRole("t-1", asOwner, "u-cli", "admin");
    expect(await isLive(session.accessToken)).toBe(true);

    // An admin re-saving an unchanged role is not a demotion.
    await members.changeRole("t-1", asOwner, "u-cli", "admin");
    expect(await isLive(session.accessToken)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Failure posture — unchanged from #1117.
// ---------------------------------------------------------------------------
describe("a failed access-token delete never breaks the removal", () => {
  it("still removes the member, and audits the shortfall", async () => {
    seedMember("t-1", "u-cli");
    await cliLogin("t-1", "u-cli");
    db.apiToken.deleteMany.mockRejectedValueOnce(new Error("db is down"));

    const res = await members.removeMember("t-1", asOwner, "u-cli");

    expect(res.removed).toBe(true);
    expect(db.membership.rows).toHaveLength(0);
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t-1",
        action: expect.stringContaining("revoking their CLI sessions failed"),
      }),
    );
  });

  it("has already closed the 90-day window even when the 12h delete fails", async () => {
    // The reason families are revoked FIRST. A failure on the second call leaves a token that
    // dies at its own `expiresAt` and cannot renew itself — strictly better than the reverse
    // ordering, which would delete one token while the family kept minting replacements.
    seedMember("t-1", "u-cli");
    const session = await cliLogin("t-1", "u-cli");
    db.apiToken.deleteMany.mockRejectedValueOnce(new Error("db is down"));

    await members.removeMember("t-1", asOwner, "u-cli");

    expect(await cliSessions.rotate(session.refreshToken)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });
});
