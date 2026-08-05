import "reflect-metadata";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { ValidationPipe } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * The Settings CLI-session list over a REAL HTTP round trip, through the REAL global AuthGuard
 * (#1078 §5).
 *
 * The unit spec proves the grouping and the ownership read. What it cannot prove is the thing this
 * screen is for: that the sessions a signed-in human is shown — and the only ones their Revoke
 * button can reach — are their own. That has to be checked from the outside, with two real humans
 * who BOTH hold a live session in the SAME workspace. A single-user test passes against a list
 * scoped only by tenant, which is exactly the bug worth catching (the trap SCIM slice 1 found).
 *
 * Everything below the HTTP boundary is real: the real controllers, the real handshake, the real
 * CliRefreshTokenService and the real AuthGuard — so a session here is created the way a session is
 * actually created, and revoking one is asserted by trying to REFRESH it afterwards. Only Prisma
 * and the identity provider are faked.
 */

interface AnyRow extends Record<string, unknown> {
  id: string;
}

const { db, tables } = vi.hoisted(() => {
  const tables: Record<string, AnyRow[]> = {
    cliAuthRequest: [],
    apiToken: [],
    cliRefreshToken: [],
  };
  let seq = 0;

  /** Prisma-ish predicate: equality by default, plus the operators these queries use. An unknown
   *  key or operator ⇒ NO match, so a query the fake doesn't understand fails closed instead of
   *  matching every row — which is how a scoping bug would hide. */
  const matches = (row: AnyRow, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, want]) => {
      const got = row[k];
      if (want instanceof Date && got instanceof Date)
        return want.getTime() === got.getTime();
      if (want && typeof want === "object" && !(want instanceof Date)) {
        return Object.entries(want as Record<string, unknown>).every(
          ([op, v]) => {
            if (op === "gt")
              return got instanceof Date && v instanceof Date && got > v;
            if (op === "lt")
              return got instanceof Date && v instanceof Date && got < v;
            if (op === "startsWith")
              return typeof got === "string" && got.startsWith(v as string);
            return false;
          },
        );
      }
      return got === want;
    });

  const delegate = (name: string) => ({
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        id: `${name}-${++seq}`,
        createdAt: new Date(),
        ...data,
      } as AnyRow;
      for (const col of [
        "approvedAt",
        "tenantId",
        "userId",
        "deniedAt",
        "consumedAt",
        "label",
        "lastUsedAt",
        "rotatedAt",
        "revokedAt",
        "expiresAt",
        "environmentId",
      ]) {
        if (!(col in row)) row[col] = null;
      }
      tables[name].push(row);
      return row;
    }),
    findUnique: vi.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        tables[name].find((r) => matches(r, where)) ?? null,
    ),
    findFirst: vi.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        tables[name].find((r) => matches(r, where)) ?? null,
    ),
    findMany: vi.fn(
      async ({ where }: { where?: Record<string, unknown> } = {}) =>
        tables[name].filter((r) => (where ? matches(r, where) : true)),
    ),
    update: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const row = tables[name].find((r) => matches(r, where));
        if (row) Object.assign(row, data);
        return row ?? null;
      },
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const hit = tables[name].filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
    ),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const keep = tables[name].filter((r) => !matches(r, where));
      const removed = tables[name].length - keep.length;
      tables[name] = keep;
      return { count: removed };
    }),
  });

  return {
    tables,
    db: {
      cliAuthRequest: delegate("cliAuthRequest"),
      apiToken: delegate("apiToken"),
      cliRefreshToken: delegate("cliRefreshToken"),
    },
  };
});

vi.mock("@naary/db", () => ({ getPrisma: () => db }));

import { ApiTokenService } from "../src/auth/api-token.service";
import { AuthGuard } from "../src/auth/auth.guard";
import { CliAuthRequestService } from "../src/auth/cli-auth-request.service";
import { CliAuthController } from "../src/auth/cli-auth.controller";
import { CliRefreshTokenService } from "../src/auth/cli-refresh-token.service";
import { CliSessionsController } from "../src/auth/cli-sessions.controller";
import { FirebaseVerifier } from "../src/auth/firebase-verifier";
import { MeController } from "../src/auth/me.controller";
import { AllExceptionsFilter } from "../src/common/all-exceptions.filter";
import { MembershipService } from "../src/membership/membership.service";
import { PermissionsService } from "../src/permissions/permissions.service";
import { SsoSessionService } from "../src/sso/sso-session.service";

/**
 * Alice and Carol are DIFFERENT humans in the SAME workspace — that pairing is the whole point of
 * this file. Bob is the cross-tenant control.
 *
 * Both of A's humans are owner/admin because `CliAuthController.approve` gates on that (minting an
 * `nry_` token is an owner/admin capability), so a plain member cannot create a session to test with.
 */
const USERS: Record<
  string,
  { userId: string; email: string; tenantId: string; role: string }
> = {
  "fb-alice": {
    userId: "user-alice",
    email: "alice@a.example",
    tenantId: "tenant-A",
    role: "owner",
  },
  "fb-carol": {
    userId: "user-carol",
    email: "carol@a.example",
    tenantId: "tenant-A",
    role: "admin",
  },
  "fb-bob": {
    userId: "user-bob",
    email: "bob@b.example",
    tenantId: "tenant-B",
    role: "owner",
  },
};

let app: INestApplication;
let base: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [CliAuthController, CliSessionsController, MeController],
    providers: [
      CliAuthRequestService,
      ApiTokenService,
      CliRefreshTokenService,
      { provide: APP_GUARD, useClass: AuthGuard },
      {
        provide: FirebaseVerifier,
        useValue: {
          enabled: true,
          verify: async (token: string) => {
            const u = USERS[token];
            return u
              ? { userId: u.userId, email: u.email, emailVerified: true }
              : null;
          },
        },
      },
      {
        provide: MembershipService,
        useValue: {
          listForUser: async (userId: string) => {
            const u = Object.values(USERS).find((x) => x.userId === userId);
            return u ? [{ tenantId: u.tenantId, role: u.role }] : [];
          },
          acceptPendingInvitations: async () => undefined,
          ensureMembership: async () => undefined,
          touchLastActive: async () => undefined,
        },
      },
      {
        provide: PermissionsService,
        useValue: { isTenantEnforced: async () => false },
      },
      {
        provide: SsoSessionService,
        useValue: { isSessionToken: () => false, verify: async () => null },
      },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  await app.listen(0);
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  for (const key of Object.keys(tables)) tables[key].length = 0;
});

type Json = Record<string, unknown>;

const request = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Json; list: Json[] }> => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body
      ? { "content-type": "application/json", ...headers }
      : headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed: unknown = await res.json();
  return {
    status: res.status,
    body: Array.isArray(parsed) ? {} : (parsed as Json),
    list: Array.isArray(parsed) ? (parsed as Json[]) : [],
  };
};

const get = (path: string, headers: Record<string, string> = {}) =>
  request("GET", path, undefined, headers);
const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) => request("POST", path, body, headers);
const del = (path: string, headers: Record<string, string> = {}) =>
  request("DELETE", path, undefined, headers);

const asUser = (idToken: string) => ({ authorization: `Bearer ${idToken}` });

/** The whole handshake for one CLI: start → the named human approves → exchange. */
async function login(idToken: string, hostname: string) {
  const started = await post("/auth/cli/start", { hostname });
  await post(
    "/auth/cli/approve",
    { userCode: started.body.userCode },
    asUser(idToken),
  );
  const exchanged = await post("/auth/cli/exchange", {
    deviceCode: started.body.deviceCode,
  });
  return {
    accessToken: String(exchanged.body.accessToken),
    refreshToken: String(exchanged.body.refreshToken),
  };
}

const sessionsOf = (idToken: string) => get("/cli-sessions", asUser(idToken));

/** Is this refresh token still good? The only honest test of "revoked" — the row's flag is our own
 *  bookkeeping, but a CLI's experience is whether `/auth/cli/refresh` still answers. */
const canStillRefresh = async (refreshToken: string): Promise<boolean> =>
  (await post("/auth/cli/refresh", { refreshToken })).status === 200;

describe("what a signed-in human sees", () => {
  it("lists one row per DEVICE, named by the machine that logged in", async () => {
    await login("fb-alice", "alices-macbook");
    await login("fb-alice", "alices-desktop");

    const res = await sessionsOf("fb-alice");
    expect(res.status).toBe(200);
    expect(res.list.map((s) => s.label).sort()).toEqual([
      "naary CLI — alices-desktop",
      "naary CLI — alices-macbook",
    ]);
    // No credential material on a screen — the family id is a random opaque handle, and nothing
    // resembling a token hash or a token is serialized.
    for (const s of res.list) {
      expect(Object.keys(s).sort()).toEqual([
        "createdAt",
        "expiresAt",
        "familyId",
        "label",
        "lastUsedAt",
      ]);
    }
  });

  it("stays ONE row as the session refreshes, and 'last used' moves", async () => {
    const { refreshToken } = await login("fb-alice", "alices-macbook");
    const before = await sessionsOf("fb-alice");

    // Two refreshes: three rows in the table, still one laptop on the screen.
    const first = await post("/auth/cli/refresh", { refreshToken });
    await post("/auth/cli/refresh", {
      refreshToken: String(first.body.refreshToken),
    });
    expect(tables.cliRefreshToken).toHaveLength(3);

    const after = await sessionsOf("fb-alice");
    expect(after.list).toHaveLength(1);
    expect(after.list[0].familyId).toBe(before.list[0].familyId);
    // "Signed in at" is the family's first row and does not drift forward with rotation.
    expect(after.list[0].createdAt).toBe(before.list[0].createdAt);
    expect(Date.parse(String(after.list[0].lastUsedAt))).toBeGreaterThanOrEqual(
      Date.parse(String(before.list[0].lastUsedAt)),
    );
  });

  it("shows nothing before a first CLI login", async () => {
    const res = await sessionsOf("fb-alice");
    expect(res.status).toBe(200);
    expect(res.list).toEqual([]);
  });
});

/**
 * The cross-user boundary — the reason this file exists. Both humans are in tenant-A and both hold
 * a live session, so a list scoped by tenant alone (or not scoped at all) FAILS here, where it
 * would pass every test above.
 */
describe("cross-user isolation, same workspace", () => {
  it("shows each human their OWN session and not their colleague's", async () => {
    await login("fb-alice", "alices-macbook");
    await login("fb-carol", "carols-thinkpad");

    const alice = await sessionsOf("fb-alice");
    const carol = await sessionsOf("fb-carol");

    // Positive and negative together: a one-sided "does not contain" would pass on an empty list.
    expect(alice.list.map((s) => s.label)).toEqual([
      "naary CLI — alices-macbook",
    ]);
    expect(carol.list.map((s) => s.label)).toEqual([
      "naary CLI — carols-thinkpad",
    ]);
    expect(alice.list[0].familyId).not.toBe(carol.list[0].familyId);
  });

  it("refuses to revoke a colleague's session — 404, and the session KEEPS WORKING", async () => {
    const aliceCli = await login("fb-alice", "alices-macbook");
    await login("fb-carol", "carols-thinkpad");
    const aliceFamily = String((await sessionsOf("fb-alice")).list[0].familyId);

    const attempt = await del(
      `/cli-sessions/${aliceFamily}`,
      asUser("fb-carol"),
    );
    expect(attempt.status).toBe(404);

    // The status code alone is not the assertion. `revokeFamily` takes a bare family id, so a
    // controller that revoked first and 404'd afterwards would look identical from out here.
    expect(
      tables.cliRefreshToken
        .filter((r) => r.familyId === aliceFamily)
        .every((r) => r.revokedAt === null),
    ).toBe(true);
    expect((await sessionsOf("fb-alice")).list).toHaveLength(1);
    expect(await canStillRefresh(aliceCli.refreshToken)).toBe(true);
  });

  it("refuses across workspaces too", async () => {
    const aliceCli = await login("fb-alice", "alices-macbook");
    const aliceFamily = String((await sessionsOf("fb-alice")).list[0].familyId);

    expect((await sessionsOf("fb-bob")).list).toEqual([]);
    expect(
      (await del(`/cli-sessions/${aliceFamily}`, asUser("fb-bob"))).status,
    ).toBe(404);
    expect(await canStillRefresh(aliceCli.refreshToken)).toBe(true);
  });
});

describe("revoking my own session", () => {
  it("removes it from the list and signs the CLI out for real", async () => {
    const cli = await login("fb-alice", "alices-macbook");
    const other = await login("fb-alice", "alices-desktop");
    const macbook = (await sessionsOf("fb-alice")).list.find(
      (s) => s.label === "naary CLI — alices-macbook",
    );

    const res = await del(
      `/cli-sessions/${String(macbook?.familyId)}`,
      asUser("fb-alice"),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: true });

    // Gone from the screen...
    expect((await sessionsOf("fb-alice")).list.map((s) => s.label)).toEqual([
      "naary CLI — alices-desktop",
    ]);
    // ...and gone for the CLI, which is the claim the button is making.
    expect(await canStillRefresh(cli.refreshToken)).toBe(false);
    // The other device is untouched — "revoke this session", not "sign me out everywhere".
    expect(await canStillRefresh(other.refreshToken)).toBe(true);
  });

  it("is not an oracle: a made-up family id and a spent one answer the same 404", async () => {
    const cli = await login("fb-alice", "alices-macbook");
    const family = String((await sessionsOf("fb-alice")).list[0].familyId);
    expect(
      (await del(`/cli-sessions/${family}`, asUser("fb-alice"))).status,
    ).toBe(200);

    const spent = await del(`/cli-sessions/${family}`, asUser("fb-alice"));
    const bogus = await del("/cli-sessions/not-a-family", asUser("fb-alice"));
    expect(spent.status).toBe(404);
    expect(bogus.status).toBe(404);
    expect(spent.body).toEqual(bogus.body);
    expect(await canStillRefresh(cli.refreshToken)).toBe(false);
  });
});

/**
 * An `nry_` API token has NO userId, and AuthGuard stamps it `role: "owner"` in an unenforced
 * workspace — so a role-based gate would hand a token the whole workspace's session list. Both
 * routes must gate on the identity instead.
 */
describe("an API token is not a person", () => {
  it("cannot list or revoke a human's sessions", async () => {
    const cli = await login("fb-alice", "alices-macbook");
    const family = String((await sessionsOf("fb-alice")).list[0].familyId);

    const listed = await get("/cli-sessions", asUser(cli.accessToken));
    expect(listed.status).toBe(403);
    expect(listed.list).toEqual([]);

    const revoked = await del(
      `/cli-sessions/${family}`,
      asUser(cli.accessToken),
    );
    expect(revoked.status).toBe(403);
    // The DELETE gate is checked separately from the GET gate, and a 403 that revoked anyway would
    // be the worst of both.
    expect(
      tables.cliRefreshToken
        .filter((r) => r.familyId === family)
        .every((r) => r.revokedAt === null),
    ).toBe(true);
    expect(await canStillRefresh(cli.refreshToken)).toBe(true);
  });

  it("still authenticates as a workspace token everywhere else", async () => {
    // Guarding against over-correction: the access token a CLI holds must keep working for real
    // requests — it is only session MANAGEMENT that requires a human.
    const cli = await login("fb-alice", "alices-macbook");
    const me = await get("/me", asUser(cli.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.tenantId).toBe("tenant-A");
  });

  it("rejects an anonymous caller outright", async () => {
    expect((await get("/cli-sessions")).status).toBe(401);
    expect((await del("/cli-sessions/anything")).status).toBe(401);
  });
});
