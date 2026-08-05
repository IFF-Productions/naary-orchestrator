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
    findFirst: vi.fn(async () => null),
  },
  scimIdentity: {
    findFirst: vi.fn(async () => null),
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

import { ApiTokenService } from "../src/auth/api-token.service";
import { AuthGuard } from "../src/auth/auth.guard";
import { FirebaseVerifier } from "../src/auth/firebase-verifier";
import { MembershipService } from "../src/membership/membership.service";
import { PermissionsService } from "../src/permissions/permissions.service";
import { ScimConnectionService } from "../src/scim/scim-connection.service";
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
      ScimGuard,
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

  it("has no write surface at all (POST/PATCH/DELETE are not routed)", async () => {
    for (const method of ["POST", "PATCH", "DELETE", "PUT"]) {
      const res = await fetch(`${base}/scim/v2/Users`, {
        method,
        headers: { authorization: `Bearer ${SCIM_TOKEN_A}` },
      });
      expect(res.status).toBe(404);
    }
    // /Groups is not implemented either — slice 1 is Users, read-only.
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
