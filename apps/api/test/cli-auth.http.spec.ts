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
 * `naary auth` over a REAL HTTP round trip, through the REAL global AuthGuard (#1078 slice 3).
 *
 * The unit spec proves the handshake state machine. What it cannot prove is the thing this slice is
 * actually for: that the token a CLI ends up holding belongs to the human who approved it in a
 * browser, and to nobody else. That has to be checked from the outside — two real users, two
 * concurrent logins, and the minted tokens fed BACK through the guard to see which workspace they
 * authenticate as. Same posture as SCIM slice 1's isolation spec.
 *
 * Everything below the HTTP boundary is real: the real controller, the real CliAuthRequestService,
 * the real ApiTokenService (so a minted `nry_` token is verified by the same code path a live
 * request uses), the real CliRefreshTokenService and the real AuthGuard. Only Prisma and the
 * identity provider are faked.
 */

interface AnyRow extends Record<string, unknown> {
  id: string;
}

const { db, tables, hooks } = vi.hoisted(() => {
  const tables: Record<string, AnyRow[]> = {
    cliAuthRequest: [],
    apiToken: [],
    cliRefreshToken: [],
  };
  const hooks: { beforeUpdateMany?: () => Promise<void> } = {};
  let seq = 0;

  /** Prisma-ish predicate: equality by default, plus the two operators this slice's queries use
   *  (`lt` for expiry, `startsWith` for the CLI label). Unknown key or unknown operator ⇒ NO match,
   *  so a query the fake doesn't understand fails closed instead of matching everything. */
  const matches = (row: AnyRow, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, want]) => {
      const got = row[k];
      if (want instanceof Date && got instanceof Date)
        return want.getTime() === got.getTime();
      if (want && typeof want === "object" && !(want instanceof Date)) {
        const ops = want as Record<string, unknown>;
        return Object.entries(ops).every(([op, v]) => {
          if (op === "lt")
            return (
              got instanceof Date && v instanceof Date && got < (v as Date)
            );
          if (op === "startsWith")
            return typeof got === "string" && got.startsWith(v as string);
          return false;
        });
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
      // Columns the services read but Prisma would default to null.
      for (const col of [
        "approvedAt",
        "tenantId",
        "userId",
        "deniedAt",
        "consumedAt",
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
        const hook = hooks.beforeUpdateMany;
        if (hook) {
          hooks.beforeUpdateMany = undefined;
          await hook();
        }
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
    hooks,
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
import { FirebaseVerifier } from "../src/auth/firebase-verifier";
import { MeController } from "../src/auth/me.controller";
import { AllExceptionsFilter } from "../src/common/all-exceptions.filter";
import { MembershipService } from "../src/membership/membership.service";
import { PermissionsService } from "../src/permissions/permissions.service";
import { SsoSessionService } from "../src/sso/sso-session.service";

/**
 * Three humans. Alice owns workspace A, Bob owns workspace B, Mallory is a plain MEMBER of A —
 * the role that must not be able to authorize a CLI login (it would mint an `nry_` token, which
 * AuthGuard stamps `role: "owner"`).
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
  "fb-bob": {
    userId: "user-bob",
    email: "bob@b.example",
    tenantId: "tenant-B",
    role: "owner",
  },
  "fb-mallory": {
    userId: "user-mallory",
    email: "mallory@a.example",
    tenantId: "tenant-A",
    role: "member",
  },
};

let app: INestApplication;
let base: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [CliAuthController, MeController],
    providers: [
      CliAuthRequestService,
      ApiTokenService,
      CliRefreshTokenService,
      // The REAL global guard, exactly as AuthModule registers it.
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
  // The same input boundary and error rendering as main.ts — without them the DTO whitelist and the
  // exception filter (which is what makes two failures byte-identical) would not be under test.
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
  hooks.beforeUpdateMany = undefined;
});

type Json = Record<string, unknown>;

const post = async (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Json }> => {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Json };
};

const get = async (
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Json }> => {
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, body: (await res.json()) as Json };
};

const asUser = (idToken: string) => ({ authorization: `Bearer ${idToken}` });

/** Run the whole handshake for one CLI: start → the named user approves → exchange. */
async function login(idToken: string, hostname = "dev-box") {
  const started = await post("/auth/cli/start", { hostname });
  const approved = await post(
    "/auth/cli/approve",
    { userCode: started.body.userCode },
    asUser(idToken),
  );
  const exchanged = await post("/auth/cli/exchange", {
    deviceCode: started.body.deviceCode,
  });
  return { started, approved, exchanged };
}

describe("the handshake, end to end", () => {
  it("mints a 12h token for the APPROVING user's workspace, and that token authenticates as it", async () => {
    const { started, exchanged } = await login("fb-alice", "alices-macbook");

    expect(started.status).toBe(201);
    expect(exchanged.status).toBe(200);
    expect(exchanged.body.status).toBe("authorized");
    expect(exchanged.body.tenantId).toBe("tenant-A");
    expect(String(exchanged.body.accessToken).startsWith("nry_")).toBe(true);
    expect(String(exchanged.body.refreshToken).startsWith("nryr_")).toBe(true);

    // Fed back through the REAL guard: this is the assertion that the credential works and is
    // scoped to exactly one workspace.
    const me = await get("/me", asUser(String(exchanged.body.accessToken)));
    expect(me.status).toBe(200);
    expect(me.body.tenantId).toBe("tenant-A");

    // §5: the session is identifiable in Settings by the device that asked for it.
    expect(tables.apiToken[0].label).toBe("naary CLI — alices-macbook");
    // §3: 12 hours, server-derived. Never non-expiring.
    const ttl =
      (tables.apiToken[0].expiresAt as Date).getTime() -
      (tables.apiToken[0].createdAt as Date).getTime();
    expect(Math.round(ttl / 3_600_000)).toBe(12);
  });

  it("reports pending until a human approves, and never leaks a token to an unapproved poll", async () => {
    const started = await post("/auth/cli/start", { hostname: "dev-box" });
    const polled = await post("/auth/cli/exchange", {
      deviceCode: started.body.deviceCode,
    });
    expect(polled.status).toBe(200);
    expect(polled.body).toEqual({ status: "pending" });
    expect(tables.apiToken).toHaveLength(0);
  });

  it("does not hand the CLI a prefilled approval link — the human must type the code", async () => {
    const started = await post("/auth/cli/start", { hostname: "dev-box" });
    // A `verification_uri_complete`-style link (RFC 8628's optional prefilled URI) is what turns a
    // device flow into a one-click phish: the victim clicks, never types the code, and so never
    // notices the code isn't theirs. The CLI gets a bare page URL and a code to read out.
    expect(String(started.body.verificationUri)).toBe("/app/cli-login");
    // The advertised window is the one the server will enforce (10 min), and the poll interval is
    // the one the exchange's rate limit was sized for. A RANGE, not 600 exactly: the value is time
    // remaining from a clock read a moment earlier, so a loaded CI shard can legitimately see 599.
    expect(Number(started.body.expiresIn)).toBeGreaterThan(590);
    expect(Number(started.body.expiresIn)).toBeLessThanOrEqual(600);
    expect(started.body.interval).toBe(5);
    expect(String(started.body.verificationUri)).not.toContain(
      String(started.body.userCode),
    );
    // The device code is the CLI's alone. It must not be discoverable from the user code.
    expect(String(started.body.verificationUri)).not.toContain(
      String(started.body.deviceCode),
    );
  });
});

/**
 * The cross-user boundary. Two real users, two live logins, no shared state — the same thing SCIM
 * slice 1 proved for tenants, proved here for humans.
 */
describe("cross-user isolation", () => {
  it("two concurrent logins never cross: each CLI gets ONLY the workspace of the user who approved it", async () => {
    const aliceStart = await post("/auth/cli/start", { hostname: "alice-box" });
    const bobStart = await post("/auth/cli/start", { hostname: "bob-box" });

    // Each user approves the code from their OWN terminal.
    await post(
      "/auth/cli/approve",
      { userCode: aliceStart.body.userCode },
      asUser("fb-alice"),
    );
    await post(
      "/auth/cli/approve",
      { userCode: bobStart.body.userCode },
      asUser("fb-bob"),
    );

    const aliceTokens = await post("/auth/cli/exchange", {
      deviceCode: aliceStart.body.deviceCode,
    });
    const bobTokens = await post("/auth/cli/exchange", {
      deviceCode: bobStart.body.deviceCode,
    });

    expect(aliceTokens.body.tenantId).toBe("tenant-A");
    expect(bobTokens.body.tenantId).toBe("tenant-B");
    expect(aliceTokens.body.accessToken).not.toBe(bobTokens.body.accessToken);

    // And the guard agrees: neither token can act in the other's workspace.
    const aliceMe = await get(
      "/me",
      asUser(String(aliceTokens.body.accessToken)),
    );
    const bobMe = await get("/me", asUser(String(bobTokens.body.accessToken)));
    expect(aliceMe.body.tenantId).toBe("tenant-A");
    expect(bobMe.body.tenantId).toBe("tenant-B");

    const crossed = await get("/me", {
      ...asUser(String(aliceTokens.body.accessToken)),
      "x-workspace-id": "tenant-B",
    });
    expect(crossed.status).toBe(403);
  });

  it("Bob approving does not authorize Alice's separate request", async () => {
    const aliceStart = await post("/auth/cli/start", { hostname: "alice-box" });
    const bobStart = await post("/auth/cli/start", { hostname: "bob-box" });

    await post(
      "/auth/cli/approve",
      { userCode: bobStart.body.userCode },
      asUser("fb-bob"),
    );

    // Alice's CLI is still waiting — one user's approval is not ambient authority over the table.
    const alicePoll = await post("/auth/cli/exchange", {
      deviceCode: aliceStart.body.deviceCode,
    });
    expect(alicePoll.body).toEqual({ status: "pending" });
    expect(tables.apiToken.every((t) => t.tenantId === "tenant-B")).toBe(true);
  });

  it("the USER code is not a credential: holding it without the device code yields nothing", async () => {
    const started = await post("/auth/cli/start", { hostname: "alice-box" });
    await post(
      "/auth/cli/approve",
      { userCode: started.body.userCode },
      asUser("fb-alice"),
    );

    // An eavesdropper who read the code off a screen tries to redeem it as if it were the secret.
    const withUserCode = await post("/auth/cli/exchange", {
      deviceCode: String(started.body.userCode),
    });
    expect(withUserCode.status).toBe(400);
    expect(tables.apiToken).toHaveLength(0);

    // The legitimate CLI, which holds the device code, still gets exactly one token.
    const real = await post("/auth/cli/exchange", {
      deviceCode: started.body.deviceCode,
    });
    expect(real.body.tenantId).toBe("tenant-A");
    expect(tables.apiToken).toHaveLength(1);
  });

  it("a denied request is dead: the CLI is told, and no token is ever minted", async () => {
    const started = await post("/auth/cli/start", { hostname: "alice-box" });

    // The anti-phishing exit — a user shown a code they did not generate kills it.
    const denied = await post(
      "/auth/cli/deny",
      { userCode: started.body.userCode },
      asUser("fb-alice"),
    );
    expect(denied.status).toBe(200);

    expect(
      (
        await post("/auth/cli/exchange", {
          deviceCode: started.body.deviceCode,
        })
      ).body,
    ).toEqual({ status: "denied" });
    // And it cannot be resurrected by approving afterwards.
    const late = await post(
      "/auth/cli/approve",
      { userCode: started.body.userCode },
      asUser("fb-alice"),
    );
    expect(late.status).toBe(400);
    expect(tables.apiToken).toHaveLength(0);
  });
});

describe("who may approve", () => {
  it("401s an anonymous approval — the identity binding is the one authenticated step", async () => {
    const started = await post("/auth/cli/start", { hostname: "dev-box" });
    const res = await post("/auth/cli/approve", {
      userCode: started.body.userCode,
    });
    expect(res.status).toBe(401);
    expect(tables.cliAuthRequest[0].approvedAt).toBeNull();
  });

  it("403s a plain member — approving mints an owner-grade `nry_` token, so it needs owner/admin", async () => {
    const started = await post("/auth/cli/start", { hostname: "dev-box" });
    const res = await post(
      "/auth/cli/approve",
      { userCode: started.body.userCode },
      asUser("fb-mallory"),
    );
    expect(res.status).toBe(403);
    expect(tables.cliAuthRequest[0].approvedAt).toBeNull();
  });

  it("403s an `nry_` API token — a token must not be able to mint another one", async () => {
    const svc = new ApiTokenService();
    const existing = await svc.mint("tenant-A", "MCP token");
    const started = await post("/auth/cli/start", { hostname: "dev-box" });

    const res = await post(
      "/auth/cli/approve",
      { userCode: started.body.userCode },
      asUser(existing.token),
    );

    expect(res.status).toBe(403);
    expect(tables.cliAuthRequest[0].approvedAt).toBeNull();
  });
});

describe("the exchange tells a spent code from nothing at all — and must not", () => {
  it("renders a replayed, an unknown and an expired device code as ONE identical failure", async () => {
    const { started } = await login("fb-alice");

    const replayed = await post("/auth/cli/exchange", {
      deviceCode: started.body.deviceCode,
    });
    const unknown = await post("/auth/cli/exchange", {
      deviceCode: "nryd_never-issued-by-anyone",
    });

    // An approved request that sat past its window.
    const stale = await post("/auth/cli/start", { hostname: "dev-box" });
    await post(
      "/auth/cli/approve",
      { userCode: stale.body.userCode },
      asUser("fb-alice"),
    );
    const staleRow = tables.cliAuthRequest.find(
      (r) => r.userCode === String(stale.body.userCode).replace("-", ""),
    );
    if (staleRow) staleRow.expiresAt = new Date(Date.now() - 1);
    const expired = await post("/auth/cli/exchange", {
      deviceCode: stale.body.deviceCode,
    });

    expect(replayed.status).toBe(400);
    // Status AND body — a differing message or an extra field would be the oracle.
    expect(replayed).toEqual(unknown);
    expect(replayed).toEqual(expired);
    // Exactly one token exists: the one the first, legitimate exchange minted.
    expect(tables.apiToken).toHaveLength(1);
  });

  it("mints exactly once even when two pollers race the same approved code", async () => {
    const started = await post("/auth/cli/start", { hostname: "dev-box" });
    await post(
      "/auth/cli/approve",
      { userCode: started.body.userCode },
      asUser("fb-alice"),
    );

    const [a, b] = await Promise.all([
      post("/auth/cli/exchange", { deviceCode: started.body.deviceCode }),
      post("/auth/cli/exchange", { deviceCode: started.body.deviceCode }),
    ]);

    const authorized = [a, b].filter((r) => r.body.status === "authorized");
    expect(authorized).toHaveLength(1);
    expect(tables.apiToken).toHaveLength(1);
  });
});

describe("refresh", () => {
  it("rotates into a fresh access token, and the presented refresh token is dead", async () => {
    const { exchanged } = await login("fb-alice");
    const first = String(exchanged.body.refreshToken);

    const rotated = await post("/auth/cli/refresh", { refreshToken: first });

    expect(rotated.status).toBe(200);
    expect(rotated.body.tenantId).toBe("tenant-A");
    expect(rotated.body.refreshToken).not.toBe(first);
    const me = await get("/me", asUser(String(rotated.body.accessToken)));
    expect(me.body.tenantId).toBe("tenant-A");
  });

  it("reports a REUSED token exactly like an unknown one — the reason is a server-side signal", async () => {
    const { exchanged } = await login("fb-alice");
    const first = String(exchanged.body.refreshToken);
    await post("/auth/cli/refresh", { refreshToken: first });

    // Past the grace window, so slice 2 treats this as a leak and revokes the family.
    const row = tables.cliRefreshToken.find((r) => r.rotatedAt);
    if (row) row.rotatedAt = new Date(Date.now() - 10 * 60_000);

    const reused = await post("/auth/cli/refresh", { refreshToken: first });
    const unknown = await post("/auth/cli/refresh", {
      refreshToken: "nryr_never-issued",
    });

    expect(reused.status).toBe(401);
    expect(reused).toEqual(unknown);
    // The whole family is down, so the successor the thief may also hold is worthless too.
    expect(tables.cliRefreshToken.every((r) => r.revokedAt !== null)).toBe(
      true,
    );
  });

  it("sweeps this workspace's DEAD CLI tokens, and leaves everything else alone", async () => {
    const svc = new ApiTokenService();
    await svc.mint(
      "tenant-A",
      "naary CLI — old-laptop",
      new Date(Date.now() - 1),
    );
    await svc.mint("tenant-A", "MCP token"); // non-expiring, Settings-minted
    // An EXPIRED token that is not a CLI session — a short-lived credential someone minted by hand.
    // Without this row the label filter is untested: every other row here is decided by the tenant
    // or the expiry filter, so deleting `startsWith` would turn nothing red.
    await svc.mint(
      "tenant-A",
      "temporary import token",
      new Date(Date.now() - 1),
    );
    await svc.mint(
      "tenant-B",
      "naary CLI — someone-else",
      new Date(Date.now() - 1),
    );

    await login("fb-alice");

    const labels = tables.apiToken.map((t) => t.label);
    expect(labels).not.toContain("naary CLI — old-laptop");
    expect(labels).toContain("MCP token");
    // Expired, but not a CLI session — the sweep has no business touching it.
    expect(labels).toContain("temporary import token");
    // Another workspace's dead token is not this login's business.
    expect(labels).toContain("naary CLI — someone-else");
  });
});

/**
 * `naary auth logout` (#1078 slice 4 — "revokes the family").
 *
 * A logout is only a logout if BOTH credentials die. Revoking the refresh family alone leaves the
 * 12-hour access token authenticating every route for the rest of the day, which is precisely the
 * window someone runs `logout` to close when they think a laptop is compromised.
 */
describe("logout", () => {
  /** 204 has no body, so this route needs a reader that doesn't call `res.json()`. */
  const postNoContent = async (
    path: string,
    body: unknown,
  ): Promise<number> => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.status;
  };

  it("kills the family AND the access token, so neither survives the command", async () => {
    const { exchanged } = await login("fb-alice");
    const accessToken = String(exchanged.body.accessToken);
    const refreshToken = String(exchanged.body.refreshToken);
    // Both work beforehand — otherwise this test could pass against a broken login.
    expect((await get("/me", asUser(accessToken))).status).toBe(200);

    expect(
      await postNoContent("/auth/cli/logout", { refreshToken, accessToken }),
    ).toBe(204);

    // The access token is gone from the store, so the REAL guard refuses it.
    expect((await get("/me", asUser(accessToken))).status).toBe(401);
    // And the family cannot mint a replacement.
    expect((await post("/auth/cli/refresh", { refreshToken })).status).toBe(
      401,
    );
    expect(tables.cliRefreshToken.every((r) => r.revokedAt !== null)).toBe(
      true,
    );
  });

  it("revokes the whole family, not just the token presented", async () => {
    // Two tokens in one lineage: the CLI presents the newest, and the older one — which a stale
    // process or a backup may still hold — must die with it.
    const { exchanged } = await login("fb-alice");
    const first = String(exchanged.body.refreshToken);
    const rotated = await post("/auth/cli/refresh", { refreshToken: first });
    const second = String(rotated.body.refreshToken);

    await postNoContent("/auth/cli/logout", { refreshToken: second });

    expect(
      (await post("/auth/cli/refresh", { refreshToken: first })).status,
    ).toBe(401);
    expect(
      (await post("/auth/cli/refresh", { refreshToken: second })).status,
    ).toBe(401);
  });

  it("does NOT trip reuse detection on an already-rotated token", async () => {
    // A logout is not a leak. Routing it through `rotate()` would log a false reuse incident for
    // any CLI that logs out holding a token a sibling process already superseded.
    const { exchanged } = await login("fb-alice");
    const first = String(exchanged.body.refreshToken);
    await post("/auth/cli/refresh", { refreshToken: first });
    const row = tables.cliRefreshToken.find((r) => r.rotatedAt);
    if (row) row.rotatedAt = new Date(Date.now() - 10 * 60_000);

    // The OLD token, well past the grace window — reuse detection's exact trigger.
    expect(
      await postNoContent("/auth/cli/logout", { refreshToken: first }),
    ).toBe(204);
    expect(tables.cliRefreshToken.every((r) => r.revokedAt !== null)).toBe(
      true,
    );
  });

  it("answers 204 to an unknown token, an empty body, and a repeat — no oracle, and idempotent", async () => {
    expect(
      await postNoContent("/auth/cli/logout", {
        refreshToken: "nryr_never-issued",
      }),
    ).toBe(204);
    expect(await postNoContent("/auth/cli/logout", {})).toBe(204);

    const { exchanged } = await login("fb-alice");
    const refreshToken = String(exchanged.body.refreshToken);
    expect(await postNoContent("/auth/cli/logout", { refreshToken })).toBe(204);
    // A CLI retrying after a network blip must not see an error for work already done.
    expect(await postNoContent("/auth/cli/logout", { refreshToken })).toBe(204);
  });

  it("cannot delete a token it was not given", async () => {
    // The presented hash IS the scope on this unauthenticated route. Bob's session is untouched by
    // Alice logging out, and a hand-made Settings token is not collateral damage either.
    const svc = new ApiTokenService();
    const settings = await svc.mint("tenant-A", "MCP token");
    const alice = await login("fb-alice");
    const bob = await login("fb-bob");

    await postNoContent("/auth/cli/logout", {
      refreshToken: String(alice.exchanged.body.refreshToken),
      accessToken: String(alice.exchanged.body.accessToken),
    });

    expect(
      (await get("/me", asUser(String(bob.exchanged.body.accessToken)))).status,
    ).toBe(200);
    expect((await get("/me", asUser(settings.token))).status).toBe(200);
    expect(
      (
        await post("/auth/cli/refresh", {
          refreshToken: String(bob.exchanged.body.refreshToken),
        })
      ).status,
    ).toBe(200);
  });
});

describe("input boundary", () => {
  it("rejects a body with unknown fields rather than silently ignoring them", async () => {
    const res = await post("/auth/cli/start", {
      hostname: "dev-box",
      tenantId: "tenant-B",
    });
    expect(res.status).toBe(400);
  });

  it("requires the device code to be a string", async () => {
    expect((await post("/auth/cli/exchange", { deviceCode: 42 })).status).toBe(
      400,
    );
    expect((await post("/auth/cli/exchange", {})).status).toBe(400);
  });
});
