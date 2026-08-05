import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SCIM 2.0 slice 1 — TENANT ISOLATION (#1075).
 *
 * This is the point of the slice. A SCIM endpoint is a door an external IdP calls with a
 * credential we issued; getting the tenant scoping wrong is a security incident, not a bug.
 * So these tests are the gate, and they are deliberately written against a Prisma FAKE that
 * reproduces the ONE semantic that makes the bug reachable:
 *
 *   `findUnique({ where: { id } })` matches on the unique field ALONE and ignores any other
 *   key you pass — so a handler that reaches for it leaks across tenants, while a handler
 *   using `findFirst({ where: { id, tenantId } })` does not.
 *
 * A mock that merely records its arguments could not tell those two apart. This one returns
 * the other tenant's row, exactly as Postgres would.
 */

// ---------------------------------------------------------------------------
// A minimal Prisma fake with REAL findUnique/findFirst semantics.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** Does `row` satisfy every scalar condition in `where`? Supports the two forms we use:
 *  a literal, and `{ equals, mode: "insensitive" }`. */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (cond === undefined) return true;
    if (cond !== null && typeof cond === "object") {
      const c = cond as { equals?: unknown; mode?: string };
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
      return true;
    }
    return row[k] === cond;
  });
}

/** A table whose `findUnique` honours ONLY the unique fields — the fidelity that makes the
 *  cross-tenant trap reachable in a test. */
function table(rows: Row[], uniqueFields: string[][] = [["id"]]) {
  return {
    rows,
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
      // Real Prisma requires a unique selector and IGNORES everything else in `where`.
      for (const fields of uniqueFields) {
        const sel: Row = {};
        let complete = true;
        for (const f of fields) {
          if (where[f] === undefined) complete = false;
          else sel[f] = where[f];
        }
        if (complete) return rows.find((r) => matches(r, sel)) ?? null;
      }
      return null;
    }),
    findFirst: vi.fn(
      async ({ where }: { where: Row }) =>
        rows.find((r) => matches(r, where)) ?? null,
    ),
    findMany: vi.fn(async ({ where }: { where?: Row } = {}) =>
      rows.filter((r) => matches(r, where)),
    ),
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
        // `where` on an upsert is a unique selector — here always (tenantId, email).
        const sel = (where.tenantId_email ?? where) as Row;
        const found = rows.find((r) => matches(r, sel));
        if (found) {
          Object.assign(found, update);
          return found;
        }
        // Prisma's @default(uuid()) / @default(now()) equivalents.
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
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = {
        id: `row-${rows.length + 1}`,
        createdAt: NOW,
        updatedAt: NOW,
        enabled: true,
        ...data,
      };
      rows.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const found = rows.find((r) => matches(r, where));
      if (found) Object.assign(found, data);
      return found ?? null;
    }),
  };
}

const NOW = new Date("2026-08-04T00:00:00Z");

const db = {
  membership: table([]),
  invitation: table([]),
  scimIdentity: table([], [["id"], ["tenantId", "email"]]),
  scimConnection: table([], [["id"], ["tokenHash"]]),
};

vi.mock("@naary/db", () => ({ getPrisma: () => db }));

import { ScimConnectionService } from "../src/scim/scim-connection.service";
import { ScimUsersService } from "../src/scim/scim-users.service";
import { ScimError } from "../src/scim/scim.errors";
import { hashScimToken } from "../src/scim/scim-token";

/** Two workspaces, each with one accepted member and one pending invitation. */
function seed(): void {
  db.membership.rows.length = 0;
  db.invitation.rows.length = 0;
  db.scimIdentity.rows.length = 0;
  db.scimConnection.rows.length = 0;

  db.membership.rows.push(
    {
      id: "m-a",
      tenantId: "tenant-A",
      userId: "uid-a",
      email: "alice@a.example",
      role: "member",
      createdAt: NOW,
    },
    {
      id: "m-b",
      tenantId: "tenant-B",
      userId: "uid-b",
      email: "bob@b.example",
      role: "member",
      createdAt: NOW,
    },
  );
  db.invitation.rows.push(
    {
      id: "i-a",
      tenantId: "tenant-A",
      email: "pending-a@a.example",
      role: "member",
      acceptedAt: null,
      createdAt: NOW,
    },
    {
      id: "i-b",
      tenantId: "tenant-B",
      email: "pending-b@b.example",
      role: "member",
      acceptedAt: null,
      createdAt: NOW,
    },
  );
}

/** SCIM failures are HttpExceptions, so the code lives behind getStatus() — asserting on the
 *  inherited private `status` field would be reading an implementation detail of Nest. */
async function expectScim404(fn: () => Promise<unknown>): Promise<void> {
  await expect(fn()).rejects.toBeInstanceOf(ScimError);
  await fn().catch((err: unknown) => {
    expect((err as ScimError).getStatus()).toBe(404);
    // The 404 must not disclose WHY — "absent" and "another tenant's" read identically.
    expect(JSON.stringify((err as ScimError).getResponse())).not.toMatch(
      /tenant|workspace|belongs/i,
    );
  });
}

const users = new ScimUsersService();
const connections = new ScimConnectionService();

beforeEach(seed);

// ---------------------------------------------------------------------------
// 1. The /Users/{id} trap — the reason this file exists.
// ---------------------------------------------------------------------------

describe("GET /scim/v2/Users/{id} — cross-tenant read", () => {
  it("404s when tenant A asks for an id belonging to tenant B, instead of returning B's user", async () => {
    // Materialise B's ids the way B's own IdP would, then steal one.
    const bList = await users.list("tenant-B", {});
    const bobId = bList.Resources.find(
      (r) => r.userName === "bob@b.example",
    )?.id;
    expect(bobId).toBeTruthy();

    // A token for tenant A, asking for tenant B's resource id.
    await expect(users.get("tenant-A", bobId as string)).rejects.toBeInstanceOf(
      ScimError,
    );
    await expectScim404(() => users.get("tenant-A", bobId as string));
  });

  it("still resolves a tenant's OWN id (the 404 above is scoping, not a broken lookup)", async () => {
    const bList = await users.list("tenant-B", {});
    const bobId = bList.Resources.find((r) => r.userName === "bob@b.example")
      ?.id as string;
    const got = await users.get("tenant-B", bobId);
    expect(got.userName).toBe("bob@b.example");
    expect(got.id).toBe(bobId);
  });

  /**
   * THE SHARP VERSION OF THE TRAP, and the reason the two tests above are not enough.
   *
   * One human, two workspaces — a consultant in both, or simply a shared domain. Both
   * tenants have a subject with the same email, so each has its own ScimIdentity row with
   * its own id. Under the naive `findUnique({ id })` the id lookup lands on B's row, the
   * follow-up subject lookup IS tenant-scoped and happily finds *A's* own alice, and the
   * handler returns 200 with **B's resource id** attached to A's user.
   *
   * That is the incident: A now holds a valid id it was never issued, and in slice 2 a
   * PATCH or DELETE against it edits B's identity row. The plain cross-tenant case 404s by
   * accident here; this one does not.
   */
  it("does not hand tenant A tenant B's resource id when both workspaces hold the same email", async () => {
    db.membership.rows.push(
      {
        id: "m-sa",
        tenantId: "tenant-A",
        userId: "uid-sa",
        email: "shared@x.example",
        role: "member",
        createdAt: NOW,
      },
      {
        id: "m-sb",
        tenantId: "tenant-B",
        userId: "uid-sb",
        email: "shared@x.example",
        role: "member",
        createdAt: NOW,
      },
    );
    const aId = (await users.list("tenant-A", {})).Resources.find(
      (r) => r.userName === "shared@x.example",
    )?.id as string;
    const bId = (await users.list("tenant-B", {})).Resources.find(
      (r) => r.userName === "shared@x.example",
    )?.id as string;
    expect(aId).toBeTruthy();
    expect(bId).toBeTruthy();
    expect(aId).not.toBe(bId); // one human, two workspaces, two resource ids

    // Tenant A presents tenant B's id. It must be a 404 — not a 200 carrying B's id.
    await expectScim404(() => users.get("tenant-A", bId));
  });

  it("never reaches for findUnique({ id }) — the lookup must carry tenantId", async () => {
    const bList = await users.list("tenant-B", {});
    const bobId = bList.Resources.find((r) => r.userName === "bob@b.example")
      ?.id as string;
    db.scimIdentity.findUnique.mockClear();
    db.scimIdentity.findFirst.mockClear();
    await users.get("tenant-B", bobId);
    // A bare findUnique on the id cannot be tenant-scoped, so it must not be the lookup.
    expect(db.scimIdentity.findUnique).not.toHaveBeenCalled();
    const where = db.scimIdentity.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: bobId, tenantId: "tenant-B" });
  });
});

// ---------------------------------------------------------------------------
// 2. Listing never crosses the boundary, at any page.
// ---------------------------------------------------------------------------

describe("GET /scim/v2/Users — listing", () => {
  it("returns only tenant A's subjects, and never a tenant B one", async () => {
    const page = await users.list("tenant-A", {});
    const names = page.Resources.map((r) => r.userName).sort();
    expect(names).toEqual(["alice@a.example", "pending-a@a.example"]);
    expect(JSON.stringify(page)).not.toContain("b.example");
  });

  it("cannot be paged past its own tenant (a large count does not spill into B)", async () => {
    const page = await users.list("tenant-A", { startIndex: 1, count: 500 });
    expect(page.totalResults).toBe(2);
    expect(page.Resources.every((r) => r.userName.endsWith("@a.example"))).toBe(
      true,
    );
  });

  it("a userName filter for another tenant's member returns zero results, not that member", async () => {
    const page = await users.list("tenant-A", {
      filter: 'userName eq "bob@b.example"',
    });
    expect(page.totalResults).toBe(0);
    expect(page.Resources).toEqual([]);
  });

  it("scopes every underlying query by tenantId", async () => {
    db.membership.findMany.mockClear();
    db.invitation.findMany.mockClear();
    await users.list("tenant-A", {});
    for (const call of db.membership.findMany.mock.calls) {
      expect(call[0]?.where).toMatchObject({ tenantId: "tenant-A" });
    }
    for (const call of db.invitation.findMany.mock.calls) {
      expect(call[0]?.where).toMatchObject({ tenantId: "tenant-A" });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Memberships AND pending invitations, distinguished by `active` (coordinator's Q4).
// ---------------------------------------------------------------------------

describe("the reconcile GET shows one namespace", () => {
  it("lists accepted members as active and pending invitations as inactive", async () => {
    const page = await users.list("tenant-A", {});
    const byName = Object.fromEntries(
      page.Resources.map((r) => [r.userName, r]),
    );
    expect(byName["alice@a.example"].active).toBe(true);
    expect(byName["pending-a@a.example"].active).toBe(false);
  });

  it("omits nobody: a pending invitation is present, so an IdP cannot conclude it must re-create them", async () => {
    const page = await users.list("tenant-A", {});
    expect(page.totalResults).toBe(2);
  });

  it("a subject who is BOTH invited and a member appears once, as the member", async () => {
    db.invitation.rows.push({
      id: "i-dupe",
      tenantId: "tenant-A",
      email: "alice@a.example",
      acceptedAt: null,
      createdAt: NOW,
    });
    const page = await users.list("tenant-A", {});
    const alice = page.Resources.filter(
      (r) => r.userName === "alice@a.example",
    );
    expect(alice).toHaveLength(1);
    expect(alice[0].active).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. The id is stable across Invitation → Membership (the slice-1 contract).
// ---------------------------------------------------------------------------

describe("stable resource id", () => {
  it("keeps the same id when a pending invitation becomes a membership", async () => {
    const before = await users.list("tenant-A", {});
    const pendingId = before.Resources.find(
      (r) => r.userName === "pending-a@a.example",
    )?.id as string;
    expect(pendingId).toBeTruthy();

    // The invitation is accepted at login: the row is consumed, a Membership appears.
    db.invitation.rows.splice(
      db.invitation.rows.findIndex((r) => r.id === "i-a"),
      1,
    );
    db.membership.rows.push({
      id: "m-a2",
      tenantId: "tenant-A",
      userId: "uid-a2",
      email: "pending-a@a.example",
      role: "member",
      createdAt: NOW,
    });

    const after = await users.list("tenant-A", {});
    const nowMember = after.Resources.find(
      (r) => r.userName === "pending-a@a.example",
    );
    expect(nowMember?.id).toBe(pendingId); // the IdP's stored id still resolves
    expect(nowMember?.active).toBe(true);
    await expect(users.get("tenant-A", pendingId)).resolves.toMatchObject({
      id: pendingId,
    });
  });

  it("matches emails case-insensitively so a differently-cased IdP record does not fork the id", async () => {
    const first = await users.list("tenant-A", {});
    const aliceId = first.Resources.find(
      (r) => r.userName === "alice@a.example",
    )?.id as string;
    db.membership.rows[0].email = "Alice@A.Example";
    const second = await users.list("tenant-A", {});
    expect(
      second.Resources.find((r) => r.userName === "alice@a.example")?.id,
    ).toBe(aliceId);
  });
});

// ---------------------------------------------------------------------------
// 5. The credential: tenant comes from the token row, and only from it.
// ---------------------------------------------------------------------------

describe("ScimConnectionService.verify", () => {
  it("resolves a minted token to its own tenant and never returns the hash", async () => {
    const minted = await connections.mint("tenant-A", "Okta", ["a.example"]);
    expect(minted.token.startsWith("nryscim_")).toBe(true);
    const verified = await connections.verify(minted.token);
    expect(verified).toMatchObject({ tenantId: "tenant-A" });
    expect(JSON.stringify(verified)).not.toContain(hashScimToken(minted.token));
    expect(JSON.stringify(minted.token)).not.toContain(minted.id);
  });

  it("stores only the sha256 — the plaintext never reaches the row", async () => {
    const minted = await connections.mint("tenant-A", "Okta", ["a.example"]);
    const row = db.scimConnection.rows.find((r) => r.id === minted.id) as Row;
    expect(row.tokenHash).toBe(hashScimToken(minted.token));
    expect(JSON.stringify(row)).not.toContain(minted.token);
  });

  it("rejects an unknown token", async () => {
    expect(await connections.verify("nryscim_nope")).toBeNull();
  });

  it("rejects a token without the SCIM prefix, even if some other table's hash collides", async () => {
    const minted = await connections.mint("tenant-A", "Okta", ["a.example"]);
    const bare = minted.token.slice("nryscim_".length);
    expect(await connections.verify(bare)).toBeNull();
    expect(await connections.verify(`nry_${bare}`)).toBeNull();
  });

  it("rejects a DISABLED connection (the kill switch)", async () => {
    const minted = await connections.mint("tenant-A", "Okta", ["a.example"]);
    const row = db.scimConnection.rows.find((r) => r.id === minted.id) as Row;
    row.enabled = false;
    expect(await connections.verify(minted.token)).toBeNull();
  });

  it("two connections in two workspaces resolve to their own tenants only", async () => {
    const a = await connections.mint("tenant-A", "Okta", ["a.example"]);
    const b = await connections.mint("tenant-B", "Entra", ["b.example"]);
    expect((await connections.verify(a.token))?.tenantId).toBe("tenant-A");
    expect((await connections.verify(b.token))?.tenantId).toBe("tenant-B");
  });
});
