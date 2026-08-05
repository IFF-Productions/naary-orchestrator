import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SCIM 2.0 slice 2 — TENANT ISOLATION ON THE WRITE PATH (#1075).
 *
 * Slice 1's isolation spec proved a cross-tenant READ cannot leak a resource. This is the same
 * gate one step worse: a PATCH or DELETE landing on another tenant's row does not merely
 * disclose a member, it DELETES one — along with their permission groups.
 *
 * Slice 1 also left the lesson that makes this file the shape it is: the obvious cross-tenant
 * test PASSED against a real bug, and only the same-email-in-two-workspaces case exposed it.
 * The write path has the identical trap in its own dialect — the email→uid hop. A lookup
 * spelled `membership.findFirst({ where: { email } })` (literally the `CompanyService.addMember`
 * bug this slice also fixes) resolves the OTHER workspace's uid; `removeMember` then no-ops on
 * a uid that is not in this tenant, and the endpoint answers 204 having deleted nothing. It
 * fails safe by luck, so a test that only checks "tenant B is untouched" goes green over a live
 * bug. Every destructive test here therefore asserts BOTH halves: the right rows are gone AND
 * the other workspace's are not.
 *
 * Run against a Prisma fake with real `findUnique` (unique-fields only) and relation-filter
 * semantics, driving the REAL MembersService — because the contract under test is precisely
 * that de-provisioning goes through it and takes the cascade with it.
 */

type Row = Record<string, unknown>;

const NOW = new Date("2026-08-05T00:00:00Z");

/**
 * Does `row` satisfy every condition in `where`? Handles the four forms this path uses: a
 * literal, `{ equals, mode }`, `{ in: [...] }`, and a NESTED RELATION filter (`group: { tenantId }`).
 * The nested case is not decoration — `removeMember` scopes its group deletes with
 * `{ userId, group: { tenantId } }`, and a fake that ignored it could not tell a tenant-scoped
 * group delete from one that wipes the user's groups in every workspace.
 */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (cond === undefined) return true;
    if (cond !== null && typeof cond === "object") {
      const c = cond as { equals?: unknown; mode?: string; in?: unknown[] };
      if ("equals" in c) {
        const a = row[k];
        const b = c.equals;
        if (
          c.mode === "insensitive" &&
          typeof a === "string" &&
          typeof b === "string"
        ) {
          return a.toLowerCase() === b.toLowerCase();
        }
        return a === b;
      }
      if ("in" in c && Array.isArray(c.in)) return c.in.includes(row[k]);
      // A relation filter: recurse into the nested row the fixture carries.
      const nested = row[k];
      if (nested && typeof nested === "object") {
        return matches(nested as Row, cond as Row);
      }
      return false;
    }
    return row[k] === cond;
  });
}

function table(
  rows: Row[],
  uniqueFields: string[][] = [["id"]],
  /** Column DEFAULTS, applied on create. `Invitation.acceptedAt` defaults to NULL in
   *  Postgres, and "pending" is spelled `acceptedAt: null` in every query on this path — a
   *  fake that left the column absent would make a freshly created invitation invisible to
   *  the code that has to find it. */
  defaults: Row = {},
) {
  return {
    rows,
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
      // Real Prisma requires a unique selector and IGNORES everything else in `where` —
      // including a `tenantId` a caller believed was scoping the query.
      for (const fields of uniqueFields) {
        const compound = fields.length > 1 ? fields.join("_") : null;
        const sel: Row = {};
        if (compound && where[compound] !== undefined) {
          Object.assign(sel, where[compound] as Row);
        } else {
          let complete = true;
          for (const f of fields) {
            if (where[f] === undefined) complete = false;
            else sel[f] = where[f];
          }
          if (!complete) continue;
        }
        if (Object.keys(sel).length > 0) {
          return rows.find((r) => matches(r, sel)) ?? null;
        }
      }
      return null;
    }),
    findFirst: vi.fn(async ({ where }: { where: Row } = { where: {} }) => {
      return rows.find((r) => matches(r, where)) ?? null;
    }),
    findMany: vi.fn(async ({ where }: { where?: Row } = {}) =>
      rows.filter((r) => matches(r, where)),
    ),
    count: vi.fn(
      async ({ where }: { where?: Row } = {}) =>
        rows.filter((r) => matches(r, where)).length,
    ),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = {
        id: `row-${rows.length + 1}`,
        createdAt: NOW,
        ...defaults,
        ...data,
      };
      rows.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const sel =
        (Object.values(where)[0] as Row)?.constructor === Object
          ? (Object.values(where)[0] as Row)
          : where;
      const found = rows.find((r) => matches(r, sel));
      if (found) Object.assign(found, data);
      return found ?? null;
    }),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: Row;
        create: Row;
        update: Row;
      }) => {
        const sel = (where.tenantId_email ?? where) as Row;
        const found = rows.find((r) => matches(r, sel));
        if (found) {
          Object.assign(found, update);
          found.updatedAt = NOW;
          return found;
        }
        const row = {
          id: `sid-${rows.length + 1}`,
          createdAt: NOW,
          updatedAt: NOW,
          ...create,
        };
        rows.push(row);
        return row;
      },
    ),
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
  membership: table([], [["id"], ["userId", "tenantId"]]),
  invitation: table([], [["id"], ["tenantId", "email"]], {
    acceptedAt: null,
    groupIds: [],
  }),
  groupMember: table([], [["groupId", "userId"]]),
  permissionGroup: table([]),
  scimIdentity: table([], [["id"], ["tenantId", "email"]]),
  tenantSettings: table([]),
  $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
};

vi.mock("@naary/db", () => ({ getPrisma: () => db }));

import { NO_HELD_APPROVALS } from "../src/executions/executions.approval-holds";
import { MembersService } from "../src/members/members.service";
import { ScimProvisioningService } from "../src/scim/scim-provisioning.service";
import { ScimUsersService } from "../src/scim/scim-users.service";
import { ScimError } from "../src/scim/scim.errors";
import type { ScimWriteContext } from "../src/scim/scim.guard";

// MembersService's collaborators. The three we assert on are the ones a hand-rolled
// `membership.deleteMany` in the SCIM layer would silently skip.
const memberships = { invalidate: vi.fn() };
const permissions = { invalidateTenant: vi.fn() };
const mailer = { sendInvitation: vi.fn(async () => {}) };
const executions = { heldApprovals: vi.fn(async () => NO_HELD_APPROVALS) };
const audit = {
  record: vi.fn(async (_input: Record<string, unknown>) => {}),
};

const members = new MembersService(
  memberships as never,
  mailer as never,
  permissions as never,
  executions as never,
  audit as never,
);
const users = new ScimUsersService();
const provisioning = new ScimProvisioningService(
  members,
  users,
  audit as never,
);

const CONN_A: ScimWriteContext = {
  connectionId: "conn-a",
  tenantId: "tenant-A",
  allowedEmailDomains: ["a.example", "x.example"],
};
const CONN_B: ScimWriteContext = {
  connectionId: "conn-b",
  tenantId: "tenant-B",
  allowedEmailDomains: ["b.example", "x.example"],
};

/**
 * Two workspaces. `shared@x.example` is a member of BOTH — one consultant, or simply a shared
 * domain — and **tenant B's row is seeded FIRST on purpose**: an email lookup that forgot its
 * `tenantId` finds B's row, which is what makes the trap reachable instead of hypothetical.
 */
function seed(): void {
  for (const t of [
    db.membership,
    db.invitation,
    db.groupMember,
    db.permissionGroup,
    db.scimIdentity,
    db.tenantSettings,
  ]) {
    t.rows.length = 0;
    for (const fn of Object.values(t)) {
      if (typeof fn === "function" && "mockClear" in fn) fn.mockClear();
    }
  }
  for (const fn of [
    memberships.invalidate,
    permissions.invalidateTenant,
    mailer.sendInvitation,
    executions.heldApprovals,
    audit.record,
  ]) {
    fn.mockClear();
  }

  db.membership.rows.push(
    {
      id: "m-shared-b",
      tenantId: "tenant-B",
      userId: "uid-shared-b",
      email: "shared@x.example",
      role: "member",
      createdAt: NOW,
      lastActiveAt: null,
    },
    {
      id: "m-shared-a",
      tenantId: "tenant-A",
      userId: "uid-shared-a",
      email: "shared@x.example",
      role: "member",
      createdAt: NOW,
      lastActiveAt: null,
    },
    {
      id: "m-owner-a",
      tenantId: "tenant-A",
      userId: "uid-owner-a",
      email: "owner@a.example",
      role: "owner",
      createdAt: NOW,
      lastActiveAt: null,
    },
    {
      id: "m-admin-a",
      tenantId: "tenant-A",
      userId: "uid-admin-a",
      email: "admin@a.example",
      role: "admin",
      createdAt: NOW,
      lastActiveAt: null,
    },
  );
  db.groupMember.rows.push(
    {
      groupId: "g-a",
      userId: "uid-shared-a",
      tenantId: "tenant-A",
      group: { tenantId: "tenant-A" },
    },
    {
      groupId: "g-b",
      userId: "uid-shared-b",
      tenantId: "tenant-B",
      group: { tenantId: "tenant-B" },
    },
  );
  db.invitation.rows.push({
    id: "i-pending-a",
    tenantId: "tenant-A",
    email: "pending@a.example",
    role: "member",
    acceptedAt: null,
    createdAt: NOW,
    groupIds: [],
  });
}

beforeEach(seed);

/** The resource id tenant `t`'s IdP would have stored for `email`. */
async function idFor(tenantId: string, email: string): Promise<string> {
  const page = await users.list(tenantId, {});
  const found = page.Resources.find((r) => r.userName === email);
  expect(found, `no SCIM resource for ${email} in ${tenantId}`).toBeTruthy();
  return found?.id as string;
}

const membershipRow = (tenantId: string, email: string) =>
  db.membership.rows.find((r) => r.tenantId === tenantId && r.email === email);

// ---------------------------------------------------------------------------
// 1. The de-provision trap: one email, two workspaces.
// ---------------------------------------------------------------------------

describe("DELETE /scim/v2/Users/{id} — cross-tenant de-provision", () => {
  /**
   * THE TEST THIS FILE EXISTS FOR.
   *
   * Tenant A de-provisions its own `shared@x.example`. Tenant B has a member with the SAME
   * email, seeded first. With an unscoped email→uid lookup, A's DELETE resolves B's uid and
   * removes NOTHING (its 204 is a lie); with a lookup scoped to the wrong side of the pair, it
   * removes B's member. Both halves are asserted, because each alone passes over one of them.
   */
  it("removes tenant A's member and leaves tenant B's same-email member untouched", async () => {
    const aId = await idFor("tenant-A", "shared@x.example");
    await provisioning.deprovision(CONN_A, aId);

    expect(membershipRow("tenant-A", "shared@x.example")).toBeUndefined();
    // …and B's identical-email member is still there, with their groups.
    expect(membershipRow("tenant-B", "shared@x.example")).toBeTruthy();
    expect(
      db.groupMember.rows.filter((r) => r.userId === "uid-shared-b"),
    ).toHaveLength(1);
    expect(
      db.groupMember.rows.filter((r) => r.userId === "uid-shared-a"),
    ).toHaveLength(0);
  });

  it("404s tenant A presenting tenant B's resource id, and deletes nothing", async () => {
    const bId = await idFor("tenant-B", "shared@x.example");
    await expect(provisioning.deprovision(CONN_A, bId)).rejects.toBeInstanceOf(
      ScimError,
    );
    expect(membershipRow("tenant-B", "shared@x.example")).toBeTruthy();
    expect(membershipRow("tenant-A", "shared@x.example")).toBeTruthy();
    expect(db.membership.deleteMany).not.toHaveBeenCalled();
  });

  it("never resolves the uid with an unscoped email lookup", async () => {
    const aId = await idFor("tenant-A", "shared@x.example");
    db.membership.findFirst.mockClear();
    await provisioning.deprovision(CONN_A, aId);
    expect(db.membership.findFirst.mock.calls.length).toBeGreaterThan(0);
    for (const call of db.membership.findFirst.mock.calls) {
      expect(call[0]?.where).toMatchObject({ tenantId: "tenant-A" });
    }
  });

  it("never reaches for findUnique({ id }) on the identity — the lookup must carry tenantId", async () => {
    const aId = await idFor("tenant-A", "shared@x.example");
    db.scimIdentity.findUnique.mockClear();
    await provisioning.deprovision(CONN_A, aId);
    expect(db.scimIdentity.findUnique).not.toHaveBeenCalled();
  });

  it("scopes the identity cleanup to its own tenant (B's identity row survives)", async () => {
    const aId = await idFor("tenant-A", "shared@x.example");
    const bId = await idFor("tenant-B", "shared@x.example");
    expect(aId).not.toBe(bId); // one human, two workspaces, two ids
    await provisioning.deprovision(CONN_A, aId);
    expect(db.scimIdentity.rows.find((r) => r.id === bId)).toBeTruthy();
    expect(db.scimIdentity.rows.find((r) => r.id === aId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. The cascade contract: de-provisioning goes through MembersService.
// ---------------------------------------------------------------------------

describe("de-provisioning routes through MembersService.removeMember", () => {
  it("takes the permission-group rows, both caches and the audit trail with it", async () => {
    const aId = await idFor("tenant-A", "shared@x.example");
    await provisioning.deprovision(CONN_A, aId);

    // The four things a hand-rolled `membership.deleteMany` would have lost.
    expect(db.groupMember.deleteMany).toHaveBeenCalled();
    expect(memberships.invalidate).toHaveBeenCalledWith("uid-shared-a");
    expect(permissions.invalidateTenant).toHaveBeenCalledWith("tenant-A");
    expect(executions.heldApprovals).toHaveBeenCalled();
  });

  it("scopes the group delete by tenant, never by uid alone", async () => {
    const aId = await idFor("tenant-A", "shared@x.example");
    await provisioning.deprovision(CONN_A, aId);
    for (const call of db.groupMember.deleteMany.mock.calls) {
      expect(call[0]?.where).toMatchObject({ group: { tenantId: "tenant-A" } });
    }
  });

  it("records an AuditEvent naming the CONNECTION as the actor, not a person", async () => {
    const aId = await idFor("tenant-A", "shared@x.example");
    await provisioning.deprovision(CONN_A, aId);
    const entry = audit.record.mock.calls
      .map((c) => c[0])
      .find((a) => String(a.action).includes("de-provisioned"));
    expect(entry).toMatchObject({
      tenantId: "tenant-A",
      actor: "scim:conn-a",
      method: "DELETE",
    });
  });
});

// ---------------------------------------------------------------------------
// 3. The two targets: a Membership, AND a pending Invitation.
// ---------------------------------------------------------------------------

describe("de-provisioning a subject who never signed in", () => {
  it("revokes the pending invitation, so accept-on-login cannot re-provision them", async () => {
    const id = await idFor("tenant-A", "pending@a.example");
    await provisioning.deprovision(CONN_A, id);
    // The row acceptPendingInvitations would have converted at their next verified sign-in.
    expect(
      db.invitation.rows.find(
        (r) => r.email === "pending@a.example" && r.acceptedAt === null,
      ),
    ).toBeUndefined();
  });

  it("also revokes a LINGERING pending invitation when the subject is already a member", async () => {
    db.invitation.rows.push({
      id: "i-lingering",
      tenantId: "tenant-A",
      email: "shared@x.example",
      role: "member",
      acceptedAt: null,
      createdAt: NOW,
      groupIds: [],
    });
    const aId = await idFor("tenant-A", "shared@x.example");
    await provisioning.deprovision(CONN_A, aId);
    expect(membershipRow("tenant-A", "shared@x.example")).toBeUndefined();
    expect(
      db.invitation.rows.find((r) => r.id === "i-lingering"),
    ).toBeUndefined();
  });

  it("leaves another workspace's pending invitation for the same email alone", async () => {
    db.invitation.rows.push({
      id: "i-b-pending",
      tenantId: "tenant-B",
      email: "pending@a.example",
      role: "member",
      acceptedAt: null,
      createdAt: NOW,
      groupIds: [],
    });
    const id = await idFor("tenant-A", "pending@a.example");
    await provisioning.deprovision(CONN_A, id);
    expect(db.invitation.rows.find((r) => r.id === "i-b-pending")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 4. A 204 must never be a lie.
// ---------------------------------------------------------------------------

describe("the de-provision post-condition", () => {
  /**
   * `ScimIdentity.userId` is a denormalised copy refreshed opportunistically on READ, so it can
   * name a uid that is stale, null, or (worst) another workspace's. Trusting it would hand
   * `removeMember` a uid it cannot match, yielding `removed: false` — a de-provision that
   * removed nothing while the IdP recorded success. The uid must be resolved fresh.
   */
  it("ignores a stale ScimIdentity.userId and removes the CURRENT membership", async () => {
    const aId = await idFor("tenant-A", "shared@x.example");
    const identity = db.scimIdentity.rows.find((r) => r.id === aId) as Row;
    identity.userId = "uid-shared-b"; // stale: the OTHER workspace's uid
    await provisioning.deprovision(CONN_A, aId);
    expect(membershipRow("tenant-A", "shared@x.example")).toBeUndefined();
    expect(membershipRow("tenant-B", "shared@x.example")).toBeTruthy();
  });

  it("500s rather than 204s if the membership somehow survives the removal", async () => {
    const aId = await idFor("tenant-A", "shared@x.example");
    // A removal that silently does nothing — the shape a stale uid or a lost cascade takes.
    const spy = vi.spyOn(members, "removeMember").mockResolvedValue({
      removed: false,
      strandedApprovals: NO_HELD_APPROVALS,
    });
    await expect(provisioning.deprovision(CONN_A, aId)).rejects.toMatchObject({
      status: 500,
    });
    spy.mockRestore();
  });

  it("500s rather than 204s if a pending invitation survives the revoke", async () => {
    const id = await idFor("tenant-A", "pending@a.example");
    const spy = vi
      .spyOn(members, "revokeInvitation")
      .mockResolvedValue(undefined);
    await expect(provisioning.deprovision(CONN_A, id)).rejects.toMatchObject({
      status: 500,
    });
    spy.mockRestore();
  });

  it("404s (and drops the stale identity row) when the subject is already gone", async () => {
    const aId = await idFor("tenant-A", "shared@x.example");
    db.membership.rows.splice(
      db.membership.rows.findIndex((r) => r.id === "m-shared-a"),
      1,
    );
    await expect(provisioning.deprovision(CONN_A, aId)).rejects.toBeInstanceOf(
      ScimError,
    );
    expect(db.scimIdentity.rows.find((r) => r.id === aId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. The role ceiling — a connection cannot de-provision an owner or admin.
// ---------------------------------------------------------------------------

describe("elevated roles are out of a connection's reach", () => {
  it.each([
    ["owner", "owner@a.example"],
    ["admin", "admin@a.example"],
  ])(
    "403s de-provisioning the workspace %s and leaves them a member",
    async (_role, email) => {
      const id = await idFor("tenant-A", email);
      await expect(provisioning.deprovision(CONN_A, id)).rejects.toMatchObject({
        status: 403,
      });
      expect(membershipRow("tenant-A", email)).toBeTruthy();
    },
  );

  /**
   * The refusal MUST be visible in the workspace: a 403 that only reaches the IdP's sync log
   * means nobody here learns a terminated admin still has access. And since a human reads this
   * sentence on the Activity screen, it is asserted as a SENTENCE — it has to name the person,
   * the role and the action the reader must take.
   */
  it("records the refusal as an AuditEvent that says who, what role, and what to do", async () => {
    const id = await idFor("tenant-A", "admin@a.example");
    await provisioning.deprovision(CONN_A, id).catch(() => undefined);
    const entry = audit.record.mock.calls
      .map((c) => c[0])
      .find((a) => String(a.action).includes("REFUSED"));
    expect(entry).toMatchObject({ tenantId: "tenant-A", actor: "scim:conn-a" });
    expect(String(entry?.action)).toContain("admin@a.example");
    expect(String(entry?.action)).toContain('"admin"');
    expect(String(entry?.action)).toContain("remove them in this workspace");
  });

  it("403s de-provisioning someone whose PENDING INVITATION is for an elevated role", async () => {
    db.invitation.rows.push({
      id: "i-admin",
      tenantId: "tenant-A",
      email: "future-admin@a.example",
      role: "admin",
      acceptedAt: null,
      createdAt: NOW,
      groupIds: [],
    });
    const id = await idFor("tenant-A", "future-admin@a.example");
    await expect(provisioning.deprovision(CONN_A, id)).rejects.toMatchObject({
      status: 403,
    });
    expect(db.invitation.rows.find((r) => r.id === "i-admin")).toBeTruthy();
    const entry = audit.record.mock.calls
      .map((c) => c[0])
      .find((a) => String(a.action).includes("REFUSED"));
    expect(String(entry?.action)).toContain("pending invitation");
    expect(String(entry?.action)).toContain("revoke it in this workspace");
  });
});

// ---------------------------------------------------------------------------
// 6. Provisioning: the §5 domain invariant, finally enforced.
// ---------------------------------------------------------------------------

describe("POST /scim/v2/Users — allowedEmailDomains (LDAP-DIRECTORY.md §5)", () => {
  it("refuses an email outside the connection's allowlist and creates nothing", async () => {
    await expect(
      provisioning.provision(CONN_A, { userName: "mallory@evil.example" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      db.invitation.rows.find((r) => r.email === "mallory@evil.example"),
    ).toBeUndefined();
  });

  it("refuses a subdomain of an allowed domain (exact match only)", async () => {
    await expect(
      provisioning.provision(CONN_A, { userName: "eve@eu.a.example" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("FAILS CLOSED on a connection with an empty allowlist", async () => {
    await expect(
      provisioning.provision(
        { ...CONN_A, allowedEmailDomains: [] },
        { userName: "anyone@a.example" },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.invitation.rows).toHaveLength(1); // only the seeded one
  });

  it("accepts an allowed domain whatever case the IdP asserts it in", async () => {
    const user = await provisioning.provision(CONN_A, {
      userName: "New.Person@A.Example",
    });
    expect(user.userName).toBe("new.person@a.example");
  });
});

describe("POST /scim/v2/Users — provisioning", () => {
  it("creates a PENDING invitation in the connection's own tenant, active:false", async () => {
    const user = await provisioning.provision(CONN_A, {
      userName: "newbie@a.example",
      externalId: "okta-123",
    });
    expect(user.active).toBe(false);
    expect(user.externalId).toBe("okta-123");
    const row = db.invitation.rows.find((r) => r.email === "newbie@a.example");
    expect(row).toMatchObject({ tenantId: "tenant-A", acceptedAt: null });
  });

  it("ignores any role the IdP asserts — Membership.role is locally administered", async () => {
    await provisioning.provision(CONN_A, {
      userName: "climber@a.example",
      roles: [{ value: "owner", primary: true }],
      role: "owner",
    });
    expect(
      db.invitation.rows.find((r) => r.email === "climber@a.example"),
    ).toMatchObject({ role: "member" });
  });

  it("returns the SAME stable id the reconcile GET will report", async () => {
    const created = await provisioning.provision(CONN_A, {
      userName: "newbie@a.example",
    });
    expect(await idFor("tenant-A", "newbie@a.example")).toBe(created.id);
    await expect(users.get("tenant-A", created.id)).resolves.toMatchObject({
      userName: "newbie@a.example",
    });
  });

  it("409s a duplicate rather than silently re-opening a removed member's invitation", async () => {
    await expect(
      provisioning.provision(CONN_A, { userName: "shared@x.example" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("cannot provision into another workspace, whatever the payload says", async () => {
    await provisioning.provision(CONN_B, {
      userName: "newbie@b.example",
      tenantId: "tenant-A",
      meta: { location: "/scim/v2/Users/tenant-A" },
    });
    expect(
      db.invitation.rows.find((r) => r.email === "newbie@b.example"),
    ).toMatchObject({ tenantId: "tenant-B" });
  });

  it.each([
    ["a missing body", undefined],
    ["an array", [{ userName: "a@a.example" }]],
    ["no userName", { externalId: "x" }],
    ["a userName that is not an email", { userName: "not-an-email" }],
  ])("400s %s", async (_label, body) => {
    await expect(provisioning.provision(CONN_A, body)).rejects.toMatchObject({
      status: 400,
    });
  });

  /** `active:false` has no home in this data model — see ScimProvisioningService's docstring.
   *  Creating the subject fully active would be the worst possible reading of it. */
  it("400s a create that asks for a DEACTIVATED user rather than creating an active one", async () => {
    await expect(
      provisioning.provision(CONN_A, {
        userName: "dormant@a.example",
        active: false,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      db.invitation.rows.find((r) => r.email === "dormant@a.example"),
    ).toBeUndefined();
  });

  it("does not let a payload key poison the row it writes", async () => {
    await provisioning.provision(CONN_A, {
      userName: "clean@a.example",
      __proto__: { polluted: true },
      constructor: { polluted: true },
      role: "owner",
      acceptedAt: NOW,
    });
    const row = db.invitation.rows.find(
      (r) => r.email === "clean@a.example",
    ) as Row;
    expect(row.acceptedAt ?? null).toBeNull();
    expect(row.role).toBe("member");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
