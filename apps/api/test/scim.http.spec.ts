import "reflect-metadata";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * SCIM over a REAL HTTP round trip, through the REAL global AuthGuard (#1075 slice 1).
 *
 * The unit specs call `ScimGuard.canActivate()` directly, which proves the guard's logic and
 * nothing about whether it RUNS. This surface is `@Public()` — the global AuthGuard returns
 * early without inspecting anything — so the entire authentication of /scim/v2 rests on the
 * ordering assumption that a controller-scoped guard executes after a global one that passed.
 *
 * That assumption fails SILENTLY in the direction that matters least and would still look
 * correct: if ScimGuard never ran, `@ScimTenant()` would throw 401 anyway. So it has to be
 * checked from the outside, against a listening server, with a credential that SHOULD work and
 * one that should not.
 */

const scimIdentityRows: Record<string, unknown>[] = [];
/** Emails the fake MembersService has "invited" — what makes a POSTed subject readable back. */
const invited = new Set<string>();
const db = {
  membership: {
    findMany: vi.fn(async ({ where }: { where: { tenantId: string } }) =>
      where.tenantId === "tenant-A"
        ? [
            {
              userId: "uid-a",
              email: "alice@a.example",
              createdAt: new Date("2026-08-04T00:00:00Z"),
            },
          ]
        : [
            {
              userId: "uid-b",
              email: "bob@b.example",
              createdAt: new Date("2026-08-04T00:00:00Z"),
            },
          ],
    ),
    findFirst: vi.fn(async () => null),
  },
  invitation: {
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(
      async ({ where }: { where: { email?: { equals?: string } } }) => {
        const email = where?.email?.equals ?? "";
        return invited.has(email)
          ? { email, createdAt: new Date("2026-08-04T00:00:00Z") }
          : null;
      },
    ),
  },
  scimIdentity: {
    // No identity row exists in this fixture, so a DELETE is a 404 — enough to prove the route
    // and the error envelope; the write SEMANTICS are scim.write-isolation.spec.ts's job.
    findFirst: vi.fn(async () => null),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    upsert: vi.fn(
      async ({
        where,
        create,
      }: {
        where: { tenantId_email: { tenantId: string; email: string } };
        create: Record<string, unknown>;
      }) => {
        const key = `${where.tenantId_email.tenantId}:${where.tenantId_email.email}`;
        const existing = scimIdentityRows.find((r) => r.key === key);
        if (existing) return existing;
        const row = {
          key,
          id: `sid-${scimIdentityRows.length + 1}`,
          createdAt: new Date("2026-08-04T00:00:00Z"),
          updatedAt: new Date("2026-08-04T00:00:00Z"),
          ...create,
        };
        scimIdentityRows.push(row);
        return row;
      },
    ),
  },
};
vi.mock("@naary/db", () => ({ getPrisma: () => db }));

import { AuditService } from "../src/audit/audit.service";
import { ApiTokenService } from "../src/auth/api-token.service";
import { AuthGuard } from "../src/auth/auth.guard";
import { FirebaseVerifier } from "../src/auth/firebase-verifier";
import { MembersService } from "../src/members/members.service";
import { MembershipService } from "../src/membership/membership.service";
import { PermissionsService } from "../src/permissions/permissions.service";
import { scimBodyParser } from "../src/scim/scim-body-parser";
import { ScimConnectionService } from "../src/scim/scim-connection.service";
import { ScimProvisioningService } from "../src/scim/scim-provisioning.service";
import { ScimUsersService } from "../src/scim/scim-users.service";
import { ScimController } from "../src/scim/scim.controller";
import { ScimGuard } from "../src/scim/scim.guard";
import { SsoSessionService } from "../src/sso/sso-session.service";

/** A valid `nry_` API token for tenant-B — the credential this door must NOT open. */
const API_TOKEN = "nry_a-real-workspace-token";
const SCIM_TOKEN_A = "nryscim_tenant-a-connection";

let app: INestApplication;
let base: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [ScimController],
    providers: [
      ScimUsersService,
      ScimProvisioningService,
      ScimGuard,
      // The member lifecycle is faked here on purpose: this spec is about the guard chain, the
      // routing and the wire format. That de-provisioning really goes through MembersService —
      // with the group cascade, the cache invalidations and the audit row — is asserted against
      // the REAL service in scim.write-isolation.spec.ts.
      {
        provide: MembersService,
        useValue: {
          invite: async (_t: string, _c: unknown, email: string) => {
            invited.add(email);
          },
          removeMember: async () => ({ removed: false }),
          revokeInvitation: async () => undefined,
        },
      },
      { provide: AuditService, useValue: { record: async () => undefined } },
      {
        provide: ScimConnectionService,
        useValue: {
          verify: async (token: string) =>
            token === SCIM_TOKEN_A
              ? {
                  connectionId: "conn-a",
                  tenantId: "tenant-A",
                  allowedEmailDomains: ["a.example"],
                }
              : null,
        },
      },
      // The REAL global guard, exactly as AuthModule registers it.
      { provide: APP_GUARD, useClass: AuthGuard },
      {
        provide: ApiTokenService,
        useValue: {
          verify: async (t: string) =>
            t === API_TOKEN
              ? { id: "tok-1", tenantId: "tenant-B", environmentId: null }
              : null,
        },
      },
      {
        provide: FirebaseVerifier,
        useValue: { enabled: false, verify: async () => null },
      },
      {
        provide: MembershipService,
        useValue: { forUser: async () => [], touchLastActive: async () => {} },
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
  // The SAME middleware main.ts installs — an IdP's `application/scim+json` body is invisible
  // to express.json() without it, and that failure only ever shows up over real HTTP.
  // Registered BEFORE init(), exactly as main.ts does it — the ordering that decides whether
  // Nest installs its own JSON parser at all (see scim-body-parser.ts).
  app.use(scimBodyParser());
  await app.init();
  await app.listen(0);
  const addr = app.getHttpServer().address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app?.close();
});

const get = async (path: string, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}${path}`, { headers });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
};

describe("GET /scim/v2/* through the real guard chain", () => {
  it("401s with no bearer — so ScimGuard DOES run behind @Public()", async () => {
    const res = await get("/scim/v2/Users");
    expect(res.status).toBe(401);
    expect(res.body.schemas).toEqual([
      "urn:ietf:params:scim:api:messages:2.0:Error",
    ]);
  });

  it("authenticates a SCIM bearer and returns that connection's OWN tenant", async () => {
    const res = await get("/scim/v2/Users", {
      authorization: `Bearer ${SCIM_TOKEN_A}`,
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain("alice@a.example");
    expect(JSON.stringify(res.body)).not.toContain("b.example");
  });

  /**
   * The credential-model assertion, end to end. A `nry_` workspace token is a full-access
   * capability — AuthGuard stamps it `role: "owner"` — and it must not be a SCIM credential.
   * If SCIM had reused the ApiToken table, this request would succeed.
   */
  it("REJECTS a valid `nry_` API token: a workspace token is not a SCIM credential", async () => {
    const res = await get("/scim/v2/Users", {
      authorization: `Bearer ${API_TOKEN}`,
    });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain("b.example");
  });

  it("ignores X-Workspace-Id — a request cannot name its own tenant here", async () => {
    const res = await get("/scim/v2/Users", {
      authorization: `Bearer ${SCIM_TOKEN_A}`,
      "x-workspace-id": "tenant-B",
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("b.example");
  });

  it("serves ServiceProviderConfig only to an authenticated connection, and advertises no writes", async () => {
    expect((await get("/scim/v2/ServiceProviderConfig")).status).toBe(401);
    const res = await get("/scim/v2/ServiceProviderConfig", {
      authorization: `Bearer ${SCIM_TOKEN_A}`,
    });
    expect(res.status).toBe(200);
    expect(res.body.patch).toEqual({ supported: false });
    expect(res.body.bulk).toMatchObject({ supported: false });
  });

  /** Slice 2 adds exactly two verbs. PATCH and PUT stay UNROUTED — and unadvertised, per the
   *  ServiceProviderConfig assertion above — because `active: false` has no home in this data
   *  model yet (see ScimProvisioningService's docstring). */
  it("routes no method beyond POST and DELETE (PATCH/PUT are still absent)", async () => {
    for (const method of ["PATCH", "PUT"]) {
      const res = await fetch(`${base}/scim/v2/Users/some-id`, {
        method,
        headers: {
          authorization: `Bearer ${SCIM_TOKEN_A}`,
          "content-type": "application/scim+json",
        },
        body: JSON.stringify({ Operations: [] }),
      });
      expect(res.status).toBe(404);
    }
    // /Groups is not implemented either — slices 1–2 are Users.
    expect(
      (
        await get("/scim/v2/Groups", {
          authorization: `Bearer ${SCIM_TOKEN_A}`,
        })
      ).status,
    ).toBe(404);
  });

  it("returns a SCIM 400 invalidFilter for an unsupported filter rather than listing everything", async () => {
    const res = await get('/scim/v2/Users?filter=userName co "a"', {
      authorization: `Bearer ${SCIM_TOKEN_A}`,
    });
    expect(res.status).toBe(400);
    expect(res.body.scimType).toBe("invalidFilter");
  });
});

describe("the WRITE surface is behind the same door (#1075 slice 2)", () => {
  const write = async (
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: res.status,
      location: res.headers.get("location"),
      text: await res.text(),
    };
  };

  it.each([
    ["POST", "/scim/v2/Users"],
    ["DELETE", "/scim/v2/Users/some-id"],
  ])(
    "401s %s with no bearer — a write cannot slip past @Public()",
    async (method, path) => {
      const res = await write(method, path, {
        "content-type": "application/scim+json",
      });
      expect(res.status).toBe(401);
      expect(res.text).toContain("urn:ietf:params:scim:api:messages:2.0:Error");
    },
  );

  /** The credential-model assertion again, on the half that DESTROYS things: an `nry_` token
   *  is stamped `role: "owner"` by AuthGuard, and must still be nothing here. */
  it.each([
    ["POST", "/scim/v2/Users"],
    ["DELETE", "/scim/v2/Users/some-id"],
  ])(
    "401s %s presented with a valid `nry_` API token",
    async (method, path) => {
      const res = await write(
        method,
        path,
        {
          authorization: `Bearer ${API_TOKEN}`,
          "content-type": "application/scim+json",
        },
        method === "POST" ? { userName: "mallory@a.example" } : undefined,
      );
      expect(res.status).toBe(401);
    },
  );

  /**
   * THE INTEROP TRAP. Okta and Entra send `application/scim+json`, which express.json() does
   * NOT match — without scimBodyParser() the body arrives empty and every create 400s with a
   * message about a missing payload, which looks like the IdP's bug and is ours.
   */
  it("parses an application/scim+json body and 201s with a Location header", async () => {
    const res = await write(
      "POST",
      "/scim/v2/Users",
      {
        authorization: `Bearer ${SCIM_TOKEN_A}`,
        "content-type": "application/scim+json",
      },
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        userName: "newbie@a.example",
        externalId: "okta-1",
      },
    );
    expect(res.status).toBe(201);
    const body = JSON.parse(res.text) as { id: string; active: boolean };
    expect(body.active).toBe(false); // provisioned = invited, not yet signed in
    expect(res.location).toBe(`/scim/v2/Users/${body.id}`);
  });

  it("also accepts a plain application/json body", async () => {
    const res = await write(
      "POST",
      "/scim/v2/Users",
      {
        authorization: `Bearer ${SCIM_TOKEN_A}`,
        "content-type": "application/json",
      },
      { userName: "second@a.example" },
    );
    expect(res.status).toBe(201);
  });

  it("400s a userName outside the connection's allowed domains", async () => {
    const res = await write(
      "POST",
      "/scim/v2/Users",
      {
        authorization: `Bearer ${SCIM_TOKEN_A}`,
        "content-type": "application/scim+json",
      },
      { userName: "mallory@evil.example" },
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text).scimType).toBe("invalidValue");
  });

  it("404s a DELETE for an id this connection was never issued, in the SCIM envelope", async () => {
    const res = await write("DELETE", "/scim/v2/Users/not-mine", {
      authorization: `Bearer ${SCIM_TOKEN_A}`,
    });
    expect(res.status).toBe(404);
    expect(res.text).toContain("urn:ietf:params:scim:api:messages:2.0:Error");
    // No hint that the id might belong to someone else.
    expect(res.text).not.toMatch(/tenant|workspace|belongs/i);
  });
});
